import { choice, exact, model, prop, sel, type Choice, type IdleRule, type Step } from "@tear/mbt";
import {
  ADMISSION_PRESETS,
  type AdmissionAction,
  type AdmissionCfg,
  type AdmissionObs,
  type AdmissionPreset,
  type AdmissionSnapshot,
  type AttachmentLabel,
  type ConnName,
  type EmailLabel,
  type EmailOutcome,
  type LegacyRcptSet,
  type RecvMsg,
  type RecvRcptSet,
  type RecvWs,
  type SendConnName,
  type SendKey,
  type SendWs,
  type StashRcptSet,
  type UploadSlot,
} from "./admission.types.ts";

const WS: readonly RecvWs[] = ["A", "B"];
const BACKLOG_HOLD = "MAILBOX_RECEIVE_BACKLOG";
const BUDGET_HOLD = "MAILBOX_RECEIVE_BUDGET";
const KEY_WS: readonly [0, 1, 0] = [0, 1, 0];

// ---- Pure JSON state types (no Map/Set for deterministic canonicalization) ----

interface Retry {
  hour: number;
  kind: number;
  stamp: number;
}

interface Receipt {
  status: string;
  letters: string;
  h: number;
  retry: Retry | null;
  error: string | null;
  born: number;
  attempts: number;
  exhausted: boolean;
}

interface RunningJob {
  letters: string;
  h: number;
  seasoned: boolean;
}

interface Jobs {
  pending: number;
  pendingSeasoned: number;
  running: RunningJob[];
}

interface RWs {
  limit: number;
  backlog: number;
  window: [number, number] | null;
  receipts: Record<string, Receipt>;
  jobs: Record<string, Jobs>;
}

interface RTxn {
  words: string[];
  phase: number;
  cursor: number;
  blocked: boolean;
  done: boolean;
  locks: string[];
  plan: [number, string, string][];
  receipts: Record<string, Receipt>;
  windows: [[number, number] | null, [number, number] | null];
  jobs: Record<string, number>;
  needJob: string[];
  released: string[];
  queued: number;
  stamp: number;
  result: unknown;
}

interface RecvState {
  h: number;
  t: number;
  stamp: number;
  ws: [RWs, RWs];
  ignored: string[];
  stash: Record<string, string>;
  txns: Record<string, RTxn>;
}

interface SWs {
  sendCap: number | null;
  pendCap: number | null;
  exempt: boolean;
  paused: boolean;
  weeks: number;
  history: number;
}

interface SEmail {
  ws: number;
  n: number;
  status: string;
  marketing: boolean;
}

interface SIdem {
  body: string;
  result: string[];
}

interface STxn {
  words: string[];
  phase: number;
  blocked: boolean;
  done: boolean;
  locks: string[];
  budget: [number, number] | null;
  idem: [string, SIdem | null] | null;
  emails: Record<string, SEmail>;
  ws: [number, SWs] | null;
  result: unknown;
}

interface SendState {
  caps: [number, number, number];
  headroom: number;
  rate: number;
  h: number;
  ws: [SWs, SWs];
  emails: Record<string, SEmail>;
  usage: [[number, number][], [number, number][]];
  emailHour: Record<string, number>;
  next: number;
  budgets: [number, number, number];
  idem: Record<string, SIdem>;
  txns: Record<string, STxn>;
}

interface USlot {
  obj: string;
  key: string | null;
  other: boolean;
}

type UIdem =
  | { state: "pending"; other: boolean; aged: boolean }
  | { state: "done"; label: string; other: boolean };

interface UploadState {
  room: number;
  used: number;
  slots: Record<string, USlot>;
  reservations: Record<string, boolean>;
  attachments: Record<string, string>;
  idem: Record<string, UIdem>;
  objects: Record<string, number>;
  foreign: number;
  deletes: string[];
  tombstones: Record<string, boolean>;
  nextObj: number;
  nextLabel: number;
}

export interface AdmissionState {
  configured: boolean;
  cfg: AdmissionCfg | null;
  recv: RecvState | null;
  send: SendState | null;
  upload: UploadState | null;
}

// ---- Small sorted-array / record helpers ----

function addUnique(arr: string[], val: string): void {
  if (!arr.includes(val)) {
    arr.push(val);
    arr.sort();
  }
}

function sortedRecord<T>(rec: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(rec).sort()) {
    out[k] = rec[k]!;
  }
  return out;
}

function cmpRetry(a: Retry, b: Retry): number {
  if (a.hour !== b.hour) return a.hour - b.hour;
  if (a.kind !== b.kind) return a.kind - b.kind;
  return a.stamp - b.stamp;
}

// ---- Recv profile logic ----

function wsOfChar(c: string): number {
  return c === "b" ? 1 : 0;
}

function splitRcpt(r: string): [[string, number], [string, number]] {
  const out: [[string, number], [string, number]] = [
    ["", 0],
    ["", 0],
  ];
  if (r === "0") return out;
  if (r === "h") {
    out[0][1] = 100;
    return out;
  }
  if (r === "x") {
    out[0][1] = 101;
    return out;
  }
  const chars = [...new Set([...r])].sort();
  for (const c of chars) {
    out[wsOfChar(c)]![0] += c;
  }
  return out;
}

function receiptCount(r: Receipt): number {
  return r.letters.length + r.h;
}

function rKey(x: number, m: string): string {
  return `${WS[x]}:${m}`;
}

function rUnkey(k: string): [number, string] {
  const idx = k.indexOf(":");
  const ws = k.slice(0, idx);
  return [ws === "A" ? 0 : 1, k.slice(idx + 1)];
}

function rWsActive(w: RWs): number {
  let sum = 0;
  for (const j of Object.values(w.jobs)) {
    sum += j.pending + j.running.length;
  }
  return sum;
}

function initRecv(limits: [[number, number], [number, number]]): RecvState {
  const mkWs = ([limit, backlog]: [number, number]): RWs => ({
    limit,
    backlog,
    window: null,
    receipts: {},
    jobs: {},
  });
  return {
    h: 0,
    t: 0,
    stamp: 1,
    ws: [mkWs(limits[0]), mkWs(limits[1])],
    ignored: [],
    stash: {},
    txns: {},
  };
}

function rTxn(s: RecvState, words: string[]): RTxn {
  return {
    words,
    phase: 0,
    cursor: 0,
    blocked: false,
    done: false,
    locks: [],
    plan: [],
    receipts: {},
    windows: [null, null],
    jobs: {},
    needJob: [],
    released: [],
    queued: 0,
    stamp: s.stamp,
    result: null,
  };
}

function rHeld(s: RecvState, me: string, lock: string): boolean {
  for (const [k, t] of Object.entries(s.txns)) {
    if (k !== me && t.locks.includes(lock)) return true;
  }
  return false;
}

function rReceipt(s: RecvState, t: RTxn, k: string): Receipt | null {
  if (k in t.receipts) return structuredClone(t.receipts[k]!);
  const [x, m] = rUnkey(k);
  const cur = s.ws[x]!.receipts[m];
  return cur ? structuredClone(cur) : null;
}

function rJobs(s: RecvState, k: string): Jobs {
  const [x, m] = rUnkey(k);
  return s.ws[x]!.jobs[m] ?? { pending: 0, pendingSeasoned: 0, running: [] };
}

function rActive(s: RecvState, x: number, t: RTxn): number {
  let sum = rWsActive(s.ws[x]!);
  for (const [k, n] of Object.entries(t.jobs)) {
    if (rUnkey(k)[0] === x) sum += n;
  }
  return sum;
}

function rDue(s: RecvState, r: Retry): boolean {
  return r.hour < s.h || (r.hour === s.h && r.kind <= 1);
}

function rSlot(s: RecvState, x: number, t: RTxn): [number, number] | null {
  const w = s.ws[x]!;
  if (w.limit <= 0) return null;
  const cur = t.windows[x] ?? w.window;
  if (cur && cur[0] === s.h) {
    return cur[1] < w.limit ? [s.h, cur[1] + 1] : null;
  }
  return [s.h, 1];
}

function rHold(s: RecvState, t: RTxn, k: string, stamp: number): void {
  const rc = rReceipt(s, t, k)!;
  rc.status = "held";
  rc.error = BACKLOG_HOLD;
  rc.retry = { hour: s.h, kind: 1, stamp };
  t.receipts[k] = rc;
}

function rQueueJob(s: RecvState, me: string, t: RTxn, k: string, stamp: number): boolean {
  const [x] = rUnkey(k);
  const turns = `turns:${WS[x]}`;
  if (rHeld(s, me, turns)) return true;
  addUnique(t.locks, turns);
  const j = rJobs(s, k);
  if (j.pending > 0) {
    const lock = `job:${k}`;
    if (rHeld(s, me, lock)) {
      rHold(s, t, k, stamp);
    } else {
      addUnique(t.locks, lock);
    }
    return false;
  }
  if (j.running.length > 0) {
    rHold(s, t, k, stamp);
    return false;
  }
  if (rActive(s, x, t) >= s.ws[x]!.backlog) {
    rHold(s, t, k, stamp);
  } else {
    t.jobs[k] = (t.jobs[k] ?? 0) + 1;
    t.queued += 1;
  }
  return false;
}

function rAdvanceRoute(s: RecvState, me: string, t: RTxn): boolean {
  if (t.phase === 0) {
    t.phase = 1;
    const rows: [number, string, string][] = [];
    if (t.words[0] === "replay") {
      const stashEntries: [string, string][] = Object.keys(s.stash)
        .sort()
        .filter((m) => !rHeld(s, me, `stash:${m}`))
        .map((m) => [m, s.stash[m]!]);
      for (const [m, r] of stashEntries) {
        addUnique(t.locks, `stash:${m}`);
        t.released.push(m);
        const parts = splitRcpt(r);
        for (let x = 0; x < 2; x++) {
          const [l, h] = parts[x]!;
          if (l.length > 0 || h > 0) rows.push([x, m, r]);
        }
      }
      t.result = stashEntries.length;
    } else {
      const m = t.words[1]!;
      const r = t.words[2]!;
      const parts = splitRcpt(r);
      for (let x = 0; x < 2; x++) {
        const [l, h] = parts[x]!;
        if (l.length > 0 || h > 0) rows.push([x, m, r]);
      }
      if (rows.length === 0) {
        const lock = `ignored:${m}`;
        if (!s.ignored.includes(m)) {
          if (rHeld(s, me, lock)) {
            t.phase = 0;
            return true;
          }
          addUnique(t.locks, lock);
        }
        t.result = { queued: 0 };
        return false;
      }
    }
    rows.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] !== b[1] ? (a[1] < b[1] ? -1 : 1) : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
    t.plan = rows;
  }

  while (t.cursor < t.plan.length) {
    const [x, m, r] = t.plan[t.cursor]!;
    const [letters, h] = splitRcpt(r)[x]!;
    const k = rKey(x, m);
    if (t.phase === 1) {
      const lock = `window:${WS[x]}`;
      if (rHeld(s, me, lock)) return true;
      addUnique(t.locks, lock);
      t.phase = 2;
    }
    const cur = rReceipt(s, t, k);
    if (!cur) {
      const rc: Receipt = {
        status: "pending",
        letters,
        h,
        retry: null,
        error: null,
        born: s.t,
        attempts: 0,
        exhausted: false,
      };
      if (receiptCount(rc) > 100) {
        rc.status = "failed";
        rc.error = BUDGET_HOLD;
      } else {
        const w = rSlot(s, x, t);
        if (w) {
          t.windows[x] = w;
          t.needJob.push(k);
        } else {
          rc.status = "held";
          rc.error = BUDGET_HOLD;
          rc.retry = { hour: s.h + 1, kind: 0, stamp: 0 };
        }
      }
      addUnique(t.locks, `receipt:${k}`);
      t.receipts[k] = rc;
    } else {
      const lock = `receipt:${k}`;
      if (rHeld(s, me, lock)) return true;
      addUnique(t.locks, lock);
      const union = [...new Set([...cur.letters, ...letters])].sort().join("");
      const uh = Math.max(cur.h, h);
      const covers = [...letters].every((c) => cur.letters.includes(c)) && cur.h >= h;
      if (cur.status !== "failed" && !covers && union.length + uh <= 200) {
        const pending = cur.status !== "held";
        const rc: Receipt = {
          ...cur,
          letters: union,
          h: uh,
          status: pending ? "pending" : "held",
        };
        t.receipts[k] = rc;
        if (pending) t.needJob.push(k);
      }
    }
    t.cursor += 1;
    t.phase = 1;
  }

  const stamp = t.stamp;
  while (t.needJob.length > 0) {
    const k = t.needJob[0]!;
    if (rQueueJob(s, me, t, k, stamp)) return true;
    t.needJob.shift();
  }
  if (t.words[0] !== "replay") {
    t.result = { queued: t.queued };
  }
  return false;
}

function rAdvanceRelease(s: RecvState, me: string, t: RTxn): boolean {
  const stamp = t.stamp;
  const due: [Retry, number, string][] = [];
  for (let x = 0; x < 2; x++) {
    const w = s.ws[x]!;
    for (const m of Object.keys(w.receipts).sort()) {
      const r = w.receipts[m]!;
      if (r.status === "held" && r.retry !== null && rDue(s, r.retry) && !rHeld(s, me, `receipt:${rKey(x, m)}`)) {
        due.push([r.retry, x, m]);
      }
    }
  }
  due.sort((a, b) => {
    const cr = cmpRetry(a[0], b[0]);
    if (cr !== 0) return cr;
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
  });
  let scanned = 0;
  for (const [, x, m] of due) {
    const k = rKey(x, m);
    addUnique(t.locks, `receipt:${k}`);
    scanned += 1;
    const rc = rReceipt(s, t, k)!;
    if (s.t - rc.born >= 72) {
      rc.status = "failed";
      rc.error = "MAILBOX_BUDGET_HOLD_EXPIRED";
      rc.retry = null;
      t.receipts[k] = rc;
      continue;
    }
    const winLock = `window:${WS[x]}`;
    const turnsLock = `turns:${WS[x]}`;
    if (rHeld(s, me, winLock) || rHeld(s, me, turnsLock)) {
      rc.retry = { hour: s.h, kind: 2, stamp };
      t.receipts[k] = rc;
      continue;
    }
    addUnique(t.locks, winLock);
    addUnique(t.locks, turnsLock);
    const nextHour: Retry = { hour: s.h + 1, kind: 0, stamp: 0 };
    if (rc.error === BACKLOG_HOLD) {
      const j = rJobs(s, k);
      if (j.running.length > 0 || (j.pending > 0 && rHeld(s, me, `job:${k}`))) {
        rc.retry = { hour: s.h, kind: 2, stamp };
      } else if (j.pending > 0 || rActive(s, x, t) < s.ws[x]!.backlog) {
        rc.status = "pending";
        rc.error = null;
        rc.retry = null;
        if (j.pending > 0) {
          addUnique(t.locks, `job:${k}`);
        } else {
          t.jobs[k] = (t.jobs[k] ?? 0) + 1;
        }
      } else {
        rc.retry = nextHour;
      }
      t.receipts[k] = rc;
      continue;
    }
    const win = rSlot(s, x, t);
    if (!win) {
      rc.retry = nextHour;
      t.receipts[k] = rc;
    } else {
      t.windows[x] = win;
      rc.status = "pending";
      rc.error = null;
      rc.retry = null;
      t.receipts[k] = rc;
      rQueueJob(s, me, t, k, stamp);
      const after = t.receipts[k];
      if (after && after.status === "held") {
        after.retry = nextHour;
      }
    }
  }
  t.result = scanned;
  return false;
}

function rAdvance(s: RecvState, me: string): void {
  const t = s.txns[me]!;
  delete s.txns[me];
  t.blocked = false;
  const blocked =
    t.words[0] === "release" ? rAdvanceRelease(s, me, t) : rAdvanceRoute(s, me, t);
  t.blocked = blocked;
  t.done = !blocked;
  s.txns[me] = t;
}

function rApply(s: RecvState, t: RTxn, seasonedKeys?: Set<string>): void {
  for (const [k, rc] of Object.entries(t.receipts)) {
    const [x, m] = rUnkey(k);
    s.ws[x]!.receipts[m] = rc;
  }
  for (let x = 0; x < 2; x++) {
    if (t.windows[x] !== null) s.ws[x]!.window = t.windows[x]!;
  }
  for (const [k, n] of Object.entries(t.jobs)) {
    const [x, m] = rUnkey(k);
    const cur = s.ws[x]!.jobs[m] ?? { pending: 0, pendingSeasoned: 0, running: [] };
    cur.pending += n;
    if (seasonedKeys?.has(k)) cur.pendingSeasoned += n;
    s.ws[x]!.jobs[m] = cur;
  }
  for (const m of t.released) {
    delete s.stash[m];
  }
  for (const l of t.locks) {
    if (l.startsWith("ignored:")) {
      addUnique(s.ignored, l.slice("ignored:".length));
    }
  }
}

function rDrain(s: RecvState, x: number): void {
  const t = rTxn(s, ["drain"]);
  addUnique(t.locks, `turns:${WS[x]}`);
  const queue: [Retry, string][] = [];
  for (const m of Object.keys(s.ws[x]!.receipts).sort()) {
    const r = s.ws[x]!.receipts[m]!;
    if (r.status === "held" && r.error === BACKLOG_HOLD && !rHeld(s, "D", `receipt:${rKey(x, m)}`)) {
      queue.push([r.retry!, m]);
    }
  }
  queue.sort((a, b) => {
    const cr = cmpRetry(a[0], b[0]);
    if (cr !== 0) return cr;
    return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  });
  const seasonedKeys = new Set<string>();
  for (const [, m] of queue) {
    const k = rKey(x, m);
    const j = rJobs(s, k);
    if (j.running.length > 0 || (j.pending > 0 && rHeld(s, "D", `job:${k}`))) continue;
    if (j.pending === 0 && rActive(s, x, t) >= s.ws[x]!.backlog) break;
    const rc = rReceipt(s, t, k)!;
    rc.status = "pending";
    rc.error = null;
    rc.retry = null;
    t.receipts[k] = rc;
    if (j.pending === 0) {
      t.jobs[k] = (t.jobs[k] ?? 0) + 1;
      if (rc.attempts > 0 && s.t - rc.born >= 1) seasonedKeys.add(k);
    }
  }
  rApply(s, t, seasonedKeys);
}

function rFinish(s: RecvState, me: string, commit: boolean): Record<string, unknown> {
  const t = s.txns[me]!;
  delete s.txns[me];
  if (commit) rApply(s, t);
  const woke: Record<string, unknown> = {};
  const waiting = Object.keys(s.txns)
    .sort()
    .filter((k) => s.txns[k]!.blocked);
  for (const w of waiting) {
    rAdvance(s, w);
    if (!s.txns[w]!.blocked) {
      woke[w] = s.txns[w]!.result;
    }
  }
  return woke;
}

function rProbe(s: RecvState, words: string[]): boolean {
  const p = structuredClone(s);
  p.txns["A"] = rTxn(p, words);
  rAdvance(p, "A");
  return !p.txns["A"]!.blocked;
}

function rEndJob(s: RecvState, x: number, m: string, how: "done" | "fail" | "lose"): number {
  const jobEntry = s.ws[x]!.jobs[m]!;
  const claimed = jobEntry.running.shift()!;
  if (jobEntry.pending === 0 && jobEntry.running.length === 0) {
    delete s.ws[x]!.jobs[m];
  }
  const rc = s.ws[x]!.receipts[m];
  let r = 0;
  if (rc && rc.status === "pending" && rc.letters === claimed.letters && rc.h === claimed.h) {
    if (how === "done") {
      rc.status = "processed";
      r = 1;
    } else if (how === "fail") {
      rc.status = "failed";
      rc.error = "MAILBOX_INGEST_FAILED";
      r = 1;
    }
  } else if (rc && how === "fail" && claimed.seasoned) {
    // A seasoned (attempts=5 -> 6 on claim) job failed without settling a reopened receipt:
    // leaves a failed attempts>=6 job row, so past 48h recoverMailReceipts reports MAILBOX_INGEST_EXHAUSTED.
    rc.exhausted = true;
  }
  rDrain(s, x);
  return r;
}

function rActionWords(a: AdmissionAction): [ConnName | null, string[]] {
  switch (a.op) {
    case "Commit":
      return [a.conn, ["commit"]];
    case "Abort":
      return [a.conn, ["abort"]];
    case "Accept":
      return [a.conn ?? null, ["accept", a.msg, a.rcpts]];
    case "LegacyAccept":
      return [a.conn ?? null, ["legacy-accept", a.msg, a.rcpts]];
    case "Release":
      return [a.conn ?? null, ["release"]];
    case "Replay":
      return [a.conn ?? null, ["replay"]];
    case "Stash":
      return [null, ["stash", a.msg, a.rcpts]];
    case "Claim":
      return [null, ["claim", a.ws, a.msg]];
    case "Done":
      return [null, ["done", a.ws, a.msg]];
    case "Fail":
      return [null, ["fail", a.ws, a.msg]];
    case "Lose":
      return [null, ["lose", a.ws, a.msg]];
    case "LegacyFail":
      return [null, ["legacy-fail", a.ws, a.msg]];
    case "Recover":
      return [null, ["recover"]];
    case "Hour":
      return [null, ["hour"]];
    case "Days":
      return [null, ["days"]];
    default:
      return [null, []];
  }
}

function rEnabled(s: RecvState, a: AdmissionAction): boolean {
  const [conn, words] = rActionWords(a);
  if (words.length === 0) return false;
  const anyBlocked = Object.values(s.txns).some((t) => t.blocked);
  if (conn !== null) {
    if (words[0] === "commit" || words[0] === "abort") {
      return Boolean(s.txns[conn]?.done);
    }
    return !(conn in s.txns) && (!anyBlocked || rProbe(s, words));
  }
  if (anyBlocked) return false;
  const open = Object.keys(s.txns).length > 0;
  const wsIdx = (w: string) => (w === "A" ? 0 : 1);
  switch (words[0]) {
    case "accept":
    case "legacy-accept":
    case "release":
    case "replay":
      return rProbe(s, words);
    case "stash":
      return !(words[1]! in s.stash);
    case "claim":
      return rJobs(s, rKey(wsIdx(words[1]!), words[2]!)).pending > 0;
    case "done":
    case "fail":
    case "lose": {
      const x = wsIdx(words[1]!);
      const k = rKey(x, words[2]!);
      const pending = s.ws[x]!.receipts[words[2]!]?.status === "pending";
      return (
        rJobs(s, k).running.length > 0 &&
        !rHeld(s, "A", `turns:${WS[x]}`) &&
        !(pending && rHeld(s, "A", `receipt:${k}`))
      );
    }
    case "legacy-fail": {
      const x = wsIdx(words[1]!);
      return words[2]! in s.ws[x]!.receipts && !rHeld(s, "A", `receipt:${rKey(x, words[2]!)}`);
    }
    case "recover":
    case "hour":
    case "days":
      return !open;
    default:
      return false;
  }
}

function rStep(s: RecvState, a: AdmissionAction): [unknown, Record<string, unknown>] {
  const [conn, words] = rActionWords(a);
  s.stamp += 1;
  if (conn !== null) {
    if (words[0] === "commit" || words[0] === "abort") {
      return ["ok", rFinish(s, conn, words[0] === "commit")];
    }
    s.txns[conn] = rTxn(s, words);
    rAdvance(s, conn);
    const t = s.txns[conn]!;
    return [t.blocked ? "blocked" : t.result, {}];
  }
  const wsIdx = (w: string) => (w === "A" ? 0 : 1);
  let r: unknown;
  switch (words[0]) {
    case "accept":
    case "legacy-accept":
    case "release":
    case "replay": {
      s.txns["A"] = rTxn(s, words);
      rAdvance(s, "A");
      r = s.txns["A"]!.result;
      rFinish(s, "A", true);
      break;
    }
    case "stash":
      s.stash[words[1]!] = words[2]!;
      r = "ok";
      break;
    case "claim": {
      const x = wsIdx(words[1]!);
      const k = rKey(x, words[2]!);
      if (rHeld(s, "A", `job:${k}`)) {
        r = 0;
      } else {
        const rc = s.ws[x]!.receipts[words[2]!];
        const j = s.ws[x]!.jobs[words[2]!]!;
        const seasoned = j.pendingSeasoned > 0 && j.pending === j.pendingSeasoned;
        if (seasoned) j.pendingSeasoned -= 1;
        j.pending -= 1;
        j.running.push({ letters: rc?.letters ?? "", h: rc?.h ?? 0, seasoned });
        r = 1;
      }
      break;
    }
    case "done":
    case "fail":
    case "lose":
      r = rEndJob(s, wsIdx(words[1]!), words[2]!, words[0]);
      break;
    case "legacy-fail":
      r = 0;
      break;
    case "recover": {
      // Updated for commits a2530111 & 249fe963 (migration 205_ingest_outage_retry.sql):
      // the 3-attempt cap was replaced by the 48-hour outage window (INGEST_OUTAGE_MS).
      const t = rTxn(s, words);
      let n = 0;
      const stamp = t.stamp;
      const seasonedKeys = new Set<string>();
      for (let x = 0; x < 2; x++) {
        const lost = Object.keys(s.ws[x]!.receipts)
          .sort()
          .filter((m) => {
            const rc = s.ws[x]!.receipts[m]!;
            const j = rJobs(s, rKey(x, m));
            return rc.status === "pending" && j.pending === 0 && j.running.length === 0;
          });
        for (const m of lost) {
          const k = rKey(x, m);
          const rc = rReceipt(s, t, k)!;
          n += 1;
          rc.attempts += 1;
          if (s.t - rc.born >= 48) {
            rc.status = "failed";
            rc.error = rc.exhausted ? "MAILBOX_INGEST_EXHAUSTED" : "MAILBOX_RECOVERY_EXHAUSTED";
            t.receipts[k] = rc;
          } else {
            t.receipts[k] = rc;
            rQueueJob(s, "A", t, k, stamp);
            if (s.t - rc.born >= 1) seasonedKeys.add(k);
          }
        }
      }
      rApply(s, t, seasonedKeys);
      r = n;
      break;
    }
    case "hour":
      s.h += 1;
      s.t += 1;
      r = "ok";
      break;
    case "days":
      s.t += 70;
      r = "ok";
      break;
    default:
      throw new Error(`unknown recv action ${words.join(" ")}`);
  }
  return [r, {}];
}

function rView(s: RecvState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let x = 0; x < 2; x++) {
    const w = s.ws[x]!;
    const receipts: Record<string, unknown> = {};
    for (const m of Object.keys(w.receipts).sort()) {
      const r = w.receipts[m]!;
      receipts[m] = [
        r.status,
        receiptCount(r),
        r.retry ? r.retry.hour : null,
        r.retry ? rDue(s, r.retry) : null,
        r.error,
      ];
    }
    const jobs: Record<string, [number, number]> = {};
    for (const m of Object.keys(w.jobs).sort()) {
      const j = w.jobs[m]!;
      if (j.pending + j.running.length > 0) {
        jobs[m] = [j.pending, j.running.length];
      }
    }
    out[WS[x]!] = {
      window: w.window && w.window[0] === s.h ? w.window[1] : 0,
      receipts,
      active: rWsActive(w),
      jobs,
    };
  }
  out.stash = Object.keys(s.stash).sort();
  return out;
}

// ---- Send profile logic ----

function emptySWs(): SWs {
  return { sendCap: null, pendCap: null, exempt: false, paused: false, weeks: 0, history: 0 };
}

function initSend(caps: [number, number, number], headroom: number, rate: number): SendState {
  return {
    caps: [...caps],
    headroom,
    rate,
    h: 0,
    ws: [emptySWs(), emptySWs()],
    emails: {},
    usage: [[], []],
    emailHour: {},
    next: 1,
    budgets: [0, 0, 0],
    idem: {},
    txns: {},
  };
}

function sHeldByOther(s: SendState, me: string, lock: string): boolean {
  const colon = lock.indexOf(":");
  const prefix = colon >= 0 ? lock.slice(0, colon) : "";
  const rest = colon >= 0 ? lock.slice(colon + 1) : "";
  const conflicts = (held: string): boolean => {
    if (prefix === "pcS") return held === `pcX:${rest}`;
    if (prefix === "wS") return held === `wX:${rest}`;
    if (prefix === "pcX") return held === `pcS:${rest}` || held === `pcX:${rest}`;
    if (prefix === "wX") return held === `wS:${rest}` || held === `wX:${rest}`;
    return held === lock;
  };
  for (const [k, t] of Object.entries(s.txns)) {
    if (k !== me && t.locks.some(conflicts)) return true;
  }
  return false;
}

function sCap(s: SendState, w: SWs): number | null {
  if (w.sendCap !== null) return w.sendCap;
  return w.exempt ? null : s.caps[0];
}

function sSponsored(w: SWs): boolean {
  return w.sendCap === null && !w.exempt;
}

function sLive(s: SendState, x: number): number {
  let sum = 0;
  for (const [h, n] of s.usage[x]!) {
    if (h > s.h - 24 && h <= s.h) sum += n;
  }
  return sum;
}

function sUsed(s: SendState, x: number): number {
  let used = sLive(s, x);
  if (sSponsored(s.ws[x]!)) {
    const y = 1 - x;
    if (sSponsored(s.ws[y]!)) used += sLive(s, y);
  }
  return used;
}

function sQueued(s: SendState, x: number, marketing: boolean | null): number {
  let count = 0;
  for (const e of Object.values(s.emails)) {
    if (e.ws === x && e.status === "queued" && (marketing === null || e.marketing === marketing)) {
      count += 1;
    }
  }
  return count;
}

function sCharge(s: SendState, x: number, hour: number, n: number): void {
  const row = s.usage[x]!.find(([h]) => h === hour);
  if (row) {
    row[1] += n;
  } else {
    s.usage[x]!.push([hour, n]);
    s.usage[x]!.sort((a, b) => a[0] - b[0]);
  }
}

function sLabel(s: SendState): string {
  const l = `e${s.next}`;
  s.next += 1;
  return l;
}

function sRequest(words: string[]): [number, boolean][] {
  if (words[0] === "send") return [[Number(words[2]), words[3] === "m"]];
  if (words[0] === "batch") return [[1, false], [1, false]];
  return [[1, false]];
}

function sAdvance(s: SendState, me: string): void {
  const t = s.txns[me]!;
  delete s.txns[me];
  t.blocked = false;
  const need = (lock: string): boolean => {
    if (sHeldByOther(s, me, lock)) return false;
    addUnique(t.locks, lock);
    return true;
  };
  const verb = t.words[0]!;
  let blocked = false;

  if (verb === "send" || verb === "batch" || verb === "idem" || verb === "idem-other") {
    const k = Number(t.words[1]) - 1;
    const x = KEY_WS[k]!;
    const xs = String(x + 1);
    const isMarketingSend = verb === "send" && t.words[3] === "m";
    const baseStatements = isMarketingSend ? 3 : 1;

    run: {
      if (t.phase === 0) {
        // Commits 9d9ae337, 28c73c39, 88822310 (migration 317_idempotency_claim.sql):
        // idempotency_admits runs BEFORE locking/charging the key's minute budget row.
        // If another open transaction holds the key's advisory xact lock and no committed row exists,
        // return 409:IDEMPOTENCY_IN_PROGRESS immediately without touching or waiting on the budget row.
        if (verb === "idem" || verb === "idem-other") {
          const idemKey = `${k + 1}:${t.words[2]}`;
          if (!(idemKey in s.idem)) {
            if (sHeldByOther(s, me, `idem:${idemKey}`)) {
              t.result = { error: "409:IDEMPOTENCY_IN_PROGRESS", statements: 1 };
              break run;
            }
            addUnique(t.locks, `idem:${idemKey}`);
          }
        }
        if (!need(`budget:${k + 1}`)) {
          blocked = true;
          break run;
        }
        const used = Math.min(s.budgets[k]! + 1, s.rate + 1);
        t.budget = [k, used];
        if (used > s.rate) {
          t.result = { error: "429:REQUEST_RATE_LIMITED", statements: 1 };
          break run;
        }
        t.phase = 1;
      }
      if (t.phase === 1) {
        if (verb === "idem" || verb === "idem-other") {
          const idemKey = `${k + 1}:${t.words[2]}`;
          const body = verb === "idem" ? "same" : "other";
          const prev = s.idem[idemKey];
          if (prev) {
            t.result =
              prev.body === body
                ? { ok: prev.result, statements: 1 }
                : { error: "409:IDEMPOTENCY_CONFLICT", statements: 1 };
            break run;
          }
          // Re-check advisory lock in case we blocked on budget before another txn grabbed it.
          if (sHeldByOther(s, me, `idem:${idemKey}`)) {
            t.result = { error: "409:IDEMPOTENCY_IN_PROGRESS", statements: 1 };
            break run;
          }
          addUnique(t.locks, `idem:${idemKey}`);
          t.idem = [idemKey, { body, result: [] }];
        }
        t.phase = 2;
      }
      if (t.phase === 2) {
        if (!need(`sched:${xs}`)) {
          blocked = true;
          break run;
        }
        t.phase = 3;
      }
      if (t.phase === 3) {
        if (sHeldByOther(s, me, `pcS:${xs}`) || sHeldByOther(s, me, `wS:${xs}`)) {
          blocked = true;
          break run;
        }
        addUnique(t.locks, `pcS:${xs}`);
        addUnique(t.locks, `wS:${xs}`);
        t.phase = 4;
      }
      if (t.phase === 4) {
        if (sSponsored(s.ws[x]!) && !need("sponsor")) {
          blocked = true;
          break run;
        }
        t.phase = 5;
      }

      const mails = sRequest(t.words);
      const cost = mails.reduce((acc, m) => acc + m[0], 0);
      const marketing = mails.filter((m) => m[1]).reduce((acc, m) => acc + m[0], 0);
      const rows = mails.length;
      const mrows = mails.filter((m) => m[1]).length;
      const w = s.ws[x]!;
      const other = s.ws[1 - x]!;
      const used = sUsed(s, x);
      // Commit 1cb0461b (migration 231_sender_standing.sql): hosted_sponsor_hold pauses
      // non-exempt siblings sharing quota_sponsor when another non-exempt sibling is paused.
      const sponsorPaused = !w.exempt && !other.exempt && other.paused;

      let error: string | null = null;
      if (w.paused || sponsorPaused) {
        error = "409:HOSTED_SENDING_PAUSED";
      } else {
        const cap = sCap(s, w);
        if (cap !== null) {
          const headroom = Math.floor((cap * s.headroom + 99) / 100);
          const mcap = w.sendCap !== null ? cap - headroom : cap;
          if (used + cost > cap || (marketing > 0 && used + marketing > mcap)) {
            error = "429:SEND_LIMIT_REACHED";
          }
        }
        if (error === null) {
          const pcap = w.pendCap ?? (w.exempt ? 200_000 : 10_000);
          const n = sQueued(s, x, null);
          const m = sQueued(s, x, true);
          const projected = Math.max(
            rows > mrows ? n - m + rows - mrows : Number.MIN_SAFE_INTEGER,
            mrows > 0 ? m + mrows : Number.MIN_SAFE_INTEGER,
          );
          if (projected > pcap) error = "429:PENDING_EMAIL_LIMIT_EXCEEDED";
        }
      }

      if (error !== null) {
        if (t.idem) t.idem = [t.idem[0], null];
        // Commit e94f4609: app.onError runs limitReached() (+1 SQL statement) on daily SEND_LIMIT_REACHED.
        const statements = baseStatements + (error === "429:SEND_LIMIT_REACHED" ? 1 : 0);
        t.result = { error, statements };
        break run;
      }

      const labels: string[] = [];
      for (const [n, mk] of mails) {
        const l = sLabel(s);
        t.emails[l] = { ws: x, n, status: "queued", marketing: mk };
        labels.push(l);
      }
      addUnique(t.locks, `mail:${xs}`);
      if (t.idem && t.idem[1]) t.idem[1].result = labels;
      t.result = { ok: labels, statements: baseStatements };
    }
  } else {
    const xs = t.words[1]!;
    const x = Number(xs) - 1;
    const w = structuredClone(s.ws[x]!);
    if (verb === "limits" || verb === "exempt") {
      if (sHeldByOther(s, me, `pcS:${xs}`) || sHeldByOther(s, me, `wX:${xs}`)) {
        blocked = true;
      } else {
        addUnique(t.locks, `pcS:${xs}`);
        addUnique(t.locks, `wX:${xs}`);
        if (verb === "limits") {
          w.sendCap = t.words[2] === "default" ? null : Number(t.words[2]);
          w.pendCap = t.words[3] === "default" ? null : Number(t.words[3]);
        } else {
          w.exempt = t.words[2] === "on";
        }
        t.ws = [x, w];
        t.result = "ok";
      }
    } else {
      if (t.phase === 1) addUnique(t.locks, `pcX:${xs}`);
      const applies = (verb === "pause") !== w.paused;
      if (!applies) {
        t.result = "noop";
      } else if (!need(`pcX:${xs}`)) {
        t.phase = 1;
        blocked = true;
      } else {
        w.paused = verb === "pause";
        t.ws = [x, w];
        t.result = "ok";
      }
    }
  }

  t.blocked = blocked;
  t.done = !blocked;
  s.txns[me] = t;
}

function sFinish(s: SendState, me: string, commit: boolean): Record<string, unknown> {
  const t = s.txns[me]!;
  delete s.txns[me];
  if (commit) {
    if (t.budget) s.budgets[t.budget[0]] = t.budget[1];
    if (t.idem) {
      if (t.idem[1] !== null) s.idem[t.idem[0]] = t.idem[1];
      else delete s.idem[t.idem[0]];
    }
    for (const [l, e] of Object.entries(t.emails)) {
      sCharge(s, e.ws, s.h, e.n);
      s.emailHour[l] = s.h;
      s.emails[l] = e;
    }
    if (t.ws) {
      const [x, w] = t.ws;
      const cur = s.ws[x]!;
      if (t.words[0] === "limits") {
        cur.sendCap = w.sendCap;
        cur.pendCap = w.pendCap;
      } else if (t.words[0] === "exempt") {
        cur.exempt = w.exempt;
      } else {
        cur.paused = w.paused;
      }
    }
  }
  const woke: Record<string, unknown> = {};
  const waiting = Object.keys(s.txns)
    .sort()
    .filter((k) => s.txns[k]!.blocked);
  for (const w of waiting) {
    sAdvance(s, w);
    if (!s.txns[w]!.blocked) {
      woke[w] = s.txns[w]!.result;
    }
  }
  return woke;
}

function sNewTxn(words: string[]): STxn {
  return {
    words,
    phase: 0,
    blocked: false,
    done: false,
    locks: [],
    budget: null,
    idem: null,
    emails: {},
    ws: null,
    result: null,
  };
}

function sProbe(s: SendState, words: string[]): boolean {
  const p = structuredClone(s);
  p.txns["A"] = sNewTxn(words);
  sAdvance(p, "A");
  return !p.txns["A"]!.blocked;
}

function sActionWords(a: AdmissionAction): [SendConnName | null, string[]] {
  switch (a.op) {
    case "Commit":
      return a.conn === "X" ? [null, []] : [a.conn, ["commit"]];
    case "Abort":
      return a.conn === "X" ? [null, []] : [a.conn, ["abort"]];
    case "Send":
      return [a.conn ?? null, ["send", String(a.key), String(a.count), a.kind]];
    case "Batch":
      return [a.conn ?? null, ["batch", String(a.key)]];
    case "Idem":
      return [a.conn ?? null, ["idem", String(a.key), a.idemKey]];
    case "IdemOther":
      return [a.conn ?? null, ["idem-other", String(a.key), a.idemKey]];
    case "Limits":
      return [
        a.conn ?? null,
        ["limits", String(a.ws), a.sendCap === null ? "default" : String(a.sendCap), a.pendCap === null ? "default" : String(a.pendCap)],
      ];
    case "Exempt":
      return [a.conn ?? null, ["exempt", String(a.ws), a.on ? "on" : "off"]];
    case "Pause":
      return [a.conn ?? null, ["pause", String(a.ws)]];
    case "Resume":
      return [a.conn ?? null, ["resume", String(a.ws)]];
    case "Me":
      return [null, ["me", String(a.key)]];
    case "Outcome":
      return [null, ["outcome", a.email, a.outcome]];
    case "History":
      return [null, ["history", String(a.ws), String(a.count)]];
    case "Hour":
      return [null, ["hour"]];
    case "H23":
      return [null, ["h23"]];
    case "Minute":
      return [null, ["minute"]];
    case "Week":
      return [null, ["week"]];
    default:
      return [null, []];
  }
}

function sEnabled(s: SendState, a: AdmissionAction): boolean {
  const [conn, words] = sActionWords(a);
  if (words.length === 0) return false;
  const anyBlocked = Object.values(s.txns).some((t) => t.blocked);
  if (conn !== null) {
    if (words[0] === "commit" || words[0] === "abort") {
      return Boolean(s.txns[conn]?.done);
    }
    return !(conn in s.txns) && (!anyBlocked || sProbe(s, words));
  }
  if (anyBlocked) return false;
  const open = Object.keys(s.txns).length > 0;
  switch (words[0]) {
    case "send":
    case "batch":
    case "idem":
    case "idem-other":
    case "limits":
    case "exempt":
    case "pause":
    case "resume":
      return sProbe(s, words);
    case "me":
      return !sHeldByOther(s, "A", `budget:${words[1]}`);
    case "outcome": {
      const e = s.emails[words[1]!];
      return Boolean(e && !sHeldByOther(s, "A", `mail:${e.ws + 1}`));
    }
    case "history":
      return true;
    case "hour":
    case "h23":
    case "minute":
    case "week":
      return !open;
    default:
      return false;
  }
}

function sStep(s: SendState, a: AdmissionAction): [unknown, Record<string, unknown>] {
  const [conn, words] = sActionWords(a);
  const start = (c: string) => {
    s.txns[c] = sNewTxn(words);
    sAdvance(s, c);
  };
  if (conn !== null) {
    if (words[0] === "commit" || words[0] === "abort") {
      return ["ok", sFinish(s, conn, words[0] === "commit")];
    }
    start(conn);
    const t = s.txns[conn]!;
    return [t.blocked ? "blocked" : t.result, {}];
  }
  let r: unknown;
  switch (words[0]) {
    case "send":
    case "batch":
    case "idem":
    case "idem-other":
    case "limits":
    case "exempt":
    case "pause":
    case "resume":
      start("A");
      r = s.txns["A"]!.result;
      sFinish(s, "A", true);
      break;
    case "me": {
      const k = Number(words[1]) - 1;
      const used = Math.min(s.budgets[k]! + 1, s.rate + 1);
      s.budgets[k] = used;
      if (used > s.rate) {
        r = "e:429:REQUEST_RATE_LIMITED";
      } else {
        const x = KEY_WS[k]!;
        r = { cap: sCap(s, s.ws[x]!), used: sUsed(s, x) };
      }
      break;
    }
    case "outcome": {
      const l = words[1]!;
      const e = s.emails[l]!;
      if (e.status !== "queued") {
        r = 0;
      } else {
        e.status = words[2]!;
        const hour = s.emailHour[l]!;
        if (words[2] !== "sent" && hour > s.h - 24) {
          sCharge(s, e.ws, hour, -e.n);
        }
        r = 1;
      }
      break;
    }
    case "history": {
      const x = Number(words[1]) - 1;
      s.ws[x]!.history += Number(words[2]);
      r = "ok";
      break;
    }
    case "hour":
    case "h23":
      s.h += words[0] === "hour" ? 1 : 23;
      s.budgets = [0, 0, 0];
      r = "ok";
      break;
    case "minute":
      s.budgets = [0, 0, 0];
      r = "ok";
      break;
    case "week":
      s.ws[0].weeks += 1;
      s.ws[1].weeks += 1;
      r = "ok";
      break;
    default:
      throw new Error(`unknown send action ${words.join(" ")}`);
  }
  return [r, {}];
}

function sView(s: SendState): Record<string, unknown> {
  const usage: Record<string, Record<string, number>> = {};
  for (let x = 0; x < 2; x++) {
    const rows: Record<string, number> = {};
    for (const [h, n] of s.usage[x]!) {
      if (n !== 0) rows[String(h)] = n;
    }
    if (Object.keys(rows).length > 0) usage[String(x + 1)] = rows;
  }
  const mails: Record<string, [string, number, string]> = {};
  for (const l of Object.keys(s.emails).sort()) {
    const e = s.emails[l]!;
    mails[l] = [e.status, e.n, String(e.ws + 1)];
  }
  const budgets: Record<string, number> = {};
  for (let k = 0; k < 3; k++) {
    if (s.budgets[k]! > 0) budgets[String(k + 1)] = s.budgets[k]!;
  }
  const depth: Record<string, number> = {};
  for (let x = 0; x < 2; x++) {
    const n = sQueued(s, x, null);
    if (n > 0) depth[String(x + 1)] = n;
  }
  return { usage, mails, budgets, depth, idem: Object.keys(s.idem).length };
}

// ---- Upload profile logic ----

function initUpload(room: number): UploadState {
  return {
    room,
    used: 0,
    slots: {},
    reservations: {},
    attachments: {},
    idem: {},
    objects: {},
    foreign: 0,
    deletes: [],
    tombstones: {},
    nextObj: 1,
    nextLabel: 1,
  };
}

function uTake(u: UploadState, obj: string): void {
  if (obj in u.reservations) {
    delete u.reservations[obj];
    u.used -= 1;
    u.tombstones[obj] = false;
  }
}

function uRefund(u: UploadState, obj: string): void {
  uTake(u, obj);
  addUnique(u.deletes, obj);
}

function uEnabled(u: UploadState, a: AdmissionAction): boolean {
  switch (a.op) {
    case "Upload":
      return !(a.slot in u.slots);
    case "PutOk":
    case "PutFail":
    case "PutCrash":
      return a.slot in u.slots;
    case "Expire":
    case "Sweep":
    case "Purge":
    case "Day":
      return true;
    case "Foreign":
      return u.foreign === 0;
    case "Delete":
      return a.attachment in u.attachments;
    default:
      return false;
  }
}

function uStep(u: UploadState, a: AdmissionAction): unknown {
  switch (a.op) {
    case "Upload": {
      const key = a.idemKey ?? null;
      const other = Boolean(a.other);
      // Commits 9d9ae337, 28c73c39, 88822310 (migration 317_idempotency_claim.sql):
      // idempotent() commits a pending claim BEFORE upload.put() (before reserving quota / R2 put).
      if (key !== null && key in u.idem) {
        const entry = u.idem[key]!;
        if (entry.state === "done") {
          return entry.other === other ? entry.label : "409:IDEMPOTENCY_CONFLICT";
        }
        if (entry.other !== other) return "409:IDEMPOTENCY_CONFLICT";
        return entry.aged ? "409:IDEMPOTENCY_OUTCOME_UNKNOWN" : "409:IDEMPOTENCY_IN_PROGRESS";
      }
      if (u.used + 1 > u.room) {
        return "413:STORED_ATTACHMENT_LIMIT_EXCEEDED";
      }
      if (key !== null) {
        u.idem[key] = { state: "pending", other, aged: false };
      }
      const obj = `o${u.nextObj}`;
      u.nextObj += 1;
      u.used += 1;
      u.reservations[obj] = false;
      u.slots[a.slot] = { obj, key, other };
      return "at-put";
    }
    case "PutOk": {
      const slot = u.slots[a.slot]!;
      delete u.slots[a.slot];
      u.objects[slot.obj] = 0;
      if (!(slot.obj in u.reservations)) {
        uRefund(u, slot.obj);
        if (slot.key !== null && u.idem[slot.key]?.state === "pending") {
          delete u.idem[slot.key];
        }
        return "503:UPLOAD_EXPIRED";
      }
      delete u.reservations[slot.obj];
      const label = `a${u.nextLabel}`;
      u.nextLabel += 1;
      u.attachments[label] = slot.obj;
      if (slot.key !== null) {
        u.idem[slot.key] = { state: "done", label, other: slot.other };
      }
      return label;
    }
    case "PutFail": {
      const slot = u.slots[a.slot]!;
      delete u.slots[a.slot];
      uRefund(u, slot.obj);
      if (slot.key !== null && u.idem[slot.key]?.state === "pending") {
        delete u.idem[slot.key];
      }
      return "500:INTERNAL_ERROR";
    }
    case "PutCrash": {
      const slot = u.slots[a.slot]!;
      delete u.slots[a.slot];
      u.objects[slot.obj] = 0;
      // Pending idempotency claim stays committed (no release ran).
      return "crashed";
    }
    case "Expire":
      for (const k of Object.keys(u.reservations)) u.reservations[k] = true;
      return "ok";
    case "Day":
      for (const k of Object.keys(u.reservations)) u.reservations[k] = true;
      for (const k of Object.keys(u.tombstones)) u.tombstones[k] = true;
      for (const k of Object.keys(u.objects)) u.objects[k] = u.objects[k]! + 1;
      for (const entry of Object.values(u.idem)) {
        if (entry.state === "pending") entry.aged = true;
      }
      return uStep(u, { op: "Sweep" });
    case "Sweep": {
      const attachedObjs = new Set(Object.values(u.attachments));
      const due = Object.keys(u.tombstones)
        .sort()
        .filter((o) => u.tombstones[o]);
      for (const o of due) {
        delete u.tombstones[o];
        if (!attachedObjs.has(o)) addUnique(u.deletes, o);
      }
      const expired = Object.keys(u.reservations)
        .sort()
        .filter((o) => u.reservations[o]);
      for (const o of expired) {
        uTake(u, o);
        addUnique(u.deletes, o);
      }
      for (const o of Object.keys(u.objects).sort()) {
        const age = u.objects[o]!;
        if (age >= 1 && !(o in u.reservations) && !attachedObjs.has(o)) {
          addUnique(u.deletes, o);
        }
      }
      return "ok";
    }
    case "Purge":
      for (const o of u.deletes) delete u.objects[o];
      u.deletes = [];
      return "ok";
    case "Foreign":
      u.foreign = 3;
      return "ok";
    case "Delete": {
      const obj = u.attachments[a.attachment]!;
      delete u.attachments[a.attachment];
      u.used -= 1;
      addUnique(u.deletes, obj);
      return "ok";
    }
    default:
      throw new Error(`unknown upload action ${a.op}`);
  }
}

function uView(u: UploadState): Record<string, unknown> {
  return {
    used: u.used,
    reservations: Object.keys(u.reservations).length,
    attachments: Object.keys(u.attachments).sort(),
    deletes: u.deletes.length,
    tombstones: Object.keys(u.tombstones).length,
    objects: Object.keys(u.objects).length,
    foreign: u.foreign,
  };
}

// ---- Alphabets & weights (matching old model.rs) ----

const RECV_ALPHABET: AdmissionAction[] = (() => {
  const out: AdmissionAction[] = [];
  const conns: (ConnName | undefined)[] = [undefined, "W", "V", "X"];
  const msgs: RecvMsg[] = ["m1", "m2", "m3"];
  const rcpts: RecvRcptSet[] = ["a", "ab", "b", "ac", "h", "x", "0"];
  const legacyRcpts: LegacyRcptSet[] = ["a", "ac", "h", "x"];
  const stashRcpts: StashRcptSet[] = ["a", "ac", "ab", "b"];
  for (const m of msgs) {
    for (const r of rcpts) {
      for (const c of conns) out.push(c ? { op: "Accept", msg: m, rcpts: r, conn: c } : { op: "Accept", msg: m, rcpts: r });
    }
    for (const r of legacyRcpts) {
      for (const c of conns) out.push(c ? { op: "LegacyAccept", msg: m, rcpts: r, conn: c } : { op: "LegacyAccept", msg: m, rcpts: r });
    }
  }
  for (const c of conns) out.push(c ? { op: "Release", conn: c } : { op: "Release" });
  for (const c of conns) out.push(c ? { op: "Replay", conn: c } : { op: "Replay" });
  for (const m of msgs) {
    for (const r of stashRcpts) out.push({ op: "Stash", msg: m, rcpts: r });
    for (const x of WS) {
      out.push({ op: "Claim", ws: x, msg: m });
      out.push({ op: "Done", ws: x, msg: m });
      out.push({ op: "Fail", ws: x, msg: m });
      out.push({ op: "Lose", ws: x, msg: m });
      out.push({ op: "LegacyFail", ws: x, msg: m });
    }
  }
  out.push({ op: "Recover" }, { op: "Hour" }, { op: "Days" });
  for (const c of ["W", "V", "X"] as const) {
    out.push({ op: "Commit", conn: c }, { op: "Abort", conn: c });
  }
  return out;
})();

const SEND_ALPHABET: AdmissionAction[] = (() => {
  const out: AdmissionAction[] = [];
  const conns: (SendConnName | undefined)[] = [undefined, "W", "V"];
  const keys: SendKey[] = [1, 2, 3];
  for (const k of keys) {
    for (const n of [1, 2, 3] as const) {
      for (const c of conns) out.push(c ? { op: "Send", key: k, count: n, kind: "t", conn: c } : { op: "Send", key: k, count: n, kind: "t" });
    }
    for (const c of conns) out.push(c ? { op: "Send", key: k, count: 1, kind: "m", conn: c } : { op: "Send", key: k, count: 1, kind: "m" });
    for (const c of conns) out.push(c ? { op: "Batch", key: k, conn: c } : { op: "Batch", key: k });
    for (const c of conns) out.push(c ? { op: "Idem", key: k, idemKey: "k1", conn: c } : { op: "Idem", key: k, idemKey: "k1" });
    for (const c of conns) out.push(c ? { op: "IdemOther", key: k, idemKey: "k1", conn: c } : { op: "IdemOther", key: k, idemKey: "k1" });
  }
  for (const x of [1, 2] as SendWs[]) {
    for (const [sc, pc] of [[2, null], [null, 1], [null, null]] as [number | null, number | null][]) {
      for (const c of conns) out.push(c ? { op: "Limits", ws: x, sendCap: sc, pendCap: pc, conn: c } : { op: "Limits", ws: x, sendCap: sc, pendCap: pc });
    }
    for (const on of [true, false]) {
      for (const c of conns) out.push(c ? { op: "Exempt", ws: x, on, conn: c } : { op: "Exempt", ws: x, on });
    }
    for (const c of conns) out.push(c ? { op: "Pause", ws: x, conn: c } : { op: "Pause", ws: x });
    for (const c of conns) out.push(c ? { op: "Resume", ws: x, conn: c } : { op: "Resume", ws: x });
  }
  for (const e of ["e1", "e2", "e3", "e4", "e5", "e6"] as EmailLabel[]) {
    for (const o of ["sent", "suppressed", "rejected", "canceled"] as EmailOutcome[]) {
      out.push({ op: "Outcome", email: e, outcome: o });
    }
  }
  out.push(
    { op: "Me", key: 1 },
    { op: "Me", key: 2 },
    { op: "Hour" },
    { op: "H23" },
    { op: "Minute" },
    { op: "Week" },
    { op: "History", ws: 1, count: 100 },
    { op: "History", ws: 1, count: 900 },
    { op: "History", ws: 2, count: 100 },
  );
  for (const c of ["W", "V"] as const) {
    out.push({ op: "Commit", conn: c }, { op: "Abort", conn: c });
  }
  return out;
})();

const UPLOAD_ALPHABET: AdmissionAction[] = (() => {
  const out: AdmissionAction[] = [];
  for (const slot of ["U1", "U2", "U3"] as UploadSlot[]) {
    out.push(
      { op: "Upload", slot },
      { op: "Upload", slot, idemKey: "k1" },
      { op: "Upload", slot, idemKey: "k1", other: true },
      { op: "PutOk", slot },
      { op: "PutFail", slot },
      { op: "PutCrash", slot },
    );
  }
  out.push({ op: "Expire" }, { op: "Sweep" }, { op: "Purge" }, { op: "Day" }, { op: "Foreign" });
  for (const attachment of ["a1", "a2", "a3", "a4"] as AttachmentLabel[]) {
    out.push({ op: "Delete", attachment });
  }
  return out;
})();

function actionWeight(a: AdmissionAction): number {
  switch (a.op) {
    case "Commit":
      return 40;
    case "Abort":
      return 8;
    case "Accept":
    case "Send":
      return a.conn ? 6 : 4;
    case "Release":
    case "Done":
    case "PutOk":
      return 6;
    case "Upload":
      return 5;
    case "Idem":
    case "IdemOther":
    case "Batch":
    case "Hour":
    case "Outcome":
      return 3;
    case "Limits":
    case "Exempt":
    case "Pause":
    case "Resume":
      return 1;
    default:
      return 2;
  }
}

// ---- Idle rules: all 9 host-independent safety invariants + leaked errors ----

const admissionIdleRules: IdleRule<AdmissionSnapshot>[] = [
  {
    id: "admission.no-leaked-errors",
    description: "no unhandled rejections or uncaught exceptions in the host",
    when: (s) => s.configured,
    check: (s) => (s.leakedErrors.length ? `leaked: ${s.leakedErrors.join("; ")}` : undefined),
  },
  {
    id: "admission.recv.backlog-counter",
    description: "mail_ingest_turns.active equals the workspace's active ingest jobs",
    when: (s) => s.configured && s.profile === "recv",
    optional: true,
    check(s) {
      for (const w of s.recv) {
        if (w.activeCounter !== w.recountActiveJobs) {
          return `${w.ws}: backlog counter ${w.activeCounter} != ${w.recountActiveJobs} active ingest jobs`;
        }
      }
      return undefined;
    },
  },
  {
    id: "admission.recv.backlog-cap",
    description: "active ingest jobs never exceed the workspace's backlog limit",
    when: (s) => s.configured && s.profile === "recv",
    optional: true,
    check(s) {
      for (const w of s.recv) {
        if (w.activeCounter > Math.max(w.backlog, 0)) {
          return `${w.ws}: ${w.activeCounter} active ingest jobs above backlog ${w.backlog}`;
        }
      }
      return undefined;
    },
  },
  {
    id: "admission.recv.one-job-per-receipt",
    description: "at most one active (pending or running) ingest job per receipt",
    when: (s) => s.configured && s.profile === "recv",
    optional: true,
    check(s) {
      for (const w of s.recv) {
        for (const [m, count] of Object.entries(w.jobsPerReceipt)) {
          if (count > 1) return `${w.ws}: ${count} active ingest jobs for ${m}`;
        }
      }
      return undefined;
    },
  },
  {
    id: "admission.recv.window-cap",
    description: "current-hour receive window never exceeds the workspace's message limit",
    when: (s) => s.configured && s.profile === "recv",
    optional: true,
    check(s) {
      for (const w of s.recv) {
        if (w.windowHourMatches && w.windowCount > Math.max(w.limit, 0)) {
          return `${w.ws}: window ${w.windowCount} above ${w.limit}-message limit`;
        }
      }
      return undefined;
    },
  },
  {
    id: "admission.send.usage-exact",
    description: "live 24h hosted_usage_hourly equals still-charged recipients admitted in the window",
    when: (s) => s.configured && s.profile === "send",
    optional: true,
    check(s) {
      for (const w of s.send) {
        if (w.liveUsage !== w.chargedRecipients) {
          return `${w.ws}: usage ${w.liveUsage} != ${w.chargedRecipients} charged recipients in window`;
        }
      }
      return undefined;
    },
  },
  {
    id: "admission.upload.usage-recount",
    description: "sending_asset_usage equals reservations plus stored attachments",
    when: (s) => s.configured && s.profile === "upload" && s.upload !== null,
    optional: true,
    check(s) {
      const u = s.upload!;
      return u.usageBytes !== u.recountBytes
        ? `asset usage ${u.usageBytes} != recount ${u.recountBytes}`
        : undefined;
    },
  },
  {
    id: "admission.upload.quota-cap",
    description: "sending_asset_usage never exceeds the workspace's stored-attachment quota",
    when: (s) => s.configured && s.profile === "upload" && s.upload !== null,
    optional: true,
    check(s) {
      const u = s.upload!;
      return u.usageBytes > u.limitBytes
        ? `asset usage ${u.usageBytes} above ${u.limitBytes}-byte quota`
        : undefined;
    },
  },
  {
    id: "admission.upload.foreign-intact",
    description: "foreign objects in the shared bucket are never deleted",
    when: (s) => s.configured && s.profile === "upload" && s.upload !== null,
    optional: true,
    check(s) {
      const u = s.upload!;
      return u.deletedForeign.length
        ? `foreign objects deleted: ${u.deletedForeign.join(", ")}`
        : undefined;
    },
  },
  {
    id: "admission.upload.no-orphan-objects",
    description: "every day-old stored upload object has an attachment, reservation, pending deletion or tombstone",
    when: (s) => s.configured && s.profile === "upload" && s.upload !== null,
    optional: true,
    check(s) {
      const u = s.upload!;
      return u.agedOrphans.length
        ? `unowned day-old objects: ${u.agedOrphans.join(", ")}`
        : undefined;
    },
  },
];

// ---- Model definition ----

function initialForPreset(preset: AdmissionPreset): AdmissionState {
  const cfg = ADMISSION_PRESETS[preset];
  return {
    configured: true,
    cfg,
    recv: cfg.profile === "recv" ? initRecv(cfg.limits) : null,
    send: cfg.profile === "send" ? initSend(cfg.caps, cfg.headroom, cfg.rate) : null,
    upload: cfg.profile === "upload" ? initUpload(cfg.room) : null,
  };
}

function viewOf(s: AdmissionState): unknown {
  if (s.recv) return rView(s.recv);
  if (s.send) return sView(s.send);
  if (s.upload) return uView(s.upload);
  return null;
}

export const admission = model<AdmissionState, AdmissionAction, AdmissionObs, AdmissionSnapshot>({
  id: "admission",
  description: "Nightmail admission and rate limits: receive window & ingest backlog, hosted send admission, stored-attachment quota",
  maxSteps: 24,
  bug: "canary_idem_duplicate",

  initial: () => ({
    configured: false,
    cfg: null,
    recv: null,
    send: null,
    upload: null,
  }),

  choices(s): Choice<AdmissionAction>[] {
    if (!s.configured) {
      return [
        choice({ op: "Configure", preset: "recv0" }, 2),
        choice({ op: "Configure", preset: "recv1" }, 2),
        choice({ op: "Configure", preset: "recv2" }, 2),
        choice({ op: "Configure", preset: "recv3" }, 1),
        choice({ op: "Configure", preset: "send0" }, 4),
        choice({ op: "Configure", preset: "send1" }, 3),
        choice({ op: "Configure", preset: "upload0" }, 3),
        choice({ op: "Configure", preset: "upload1" }, 2),
      ];
    }
    const out: Choice<AdmissionAction>[] = [];
    if (s.recv) {
      for (const a of RECV_ALPHABET) {
        if (rEnabled(s.recv, a)) out.push(choice(a, actionWeight(a)));
      }
    } else if (s.send) {
      for (const a of SEND_ALPHABET) {
        if (sEnabled(s.send, a)) out.push(choice(a, actionWeight(a)));
      }
    } else if (s.upload) {
      for (const a of UPLOAD_ALPHABET) {
        if (uEnabled(s.upload, a)) out.push(choice(a, actionWeight(a)));
      }
    }
    return out;
  },

  step(s, a): Step<AdmissionState, AdmissionObs> {
    if (a.op === "Configure") {
      const next = initialForPreset(a.preset);
      return {
        next,
        expect: exact({ r: "ok", woke: {}, view: viewOf(next) }),
      };
    }
    const next = structuredClone(s);
    if (next.recv) {
      const [r, woke] = rStep(next.recv, a);
      return { next, expect: exact({ r, woke: sortedRecord(woke), view: rView(next.recv) }) };
    }
    if (next.send) {
      const [r, woke] = sStep(next.send, a);
      return { next, expect: exact({ r, woke: sortedRecord(woke), view: sView(next.send) }) };
    }
    if (next.upload) {
      const r = uStep(next.upload, a);
      return { next, expect: exact({ r, woke: {}, view: uView(next.upload) }) };
    }
    throw new Error("admission model: action before Configure");
  },

  idle: admissionIdleRules,

  // Declarative temporal properties for ordering and at-most-once rules:
  temporal: [
    {
      id: "admission.recv.failed-final",
      title: "a failed receipt is never reopened back to pending",
      prop: prop.optional(
        prop.forEach(
          { name: "receipt", discover: sel.event("recv.receipt.failed"), key: "/receipt" },
          (receipt) => [prop.never(sel.event("recv.receipt.reopened", { "/receipt": receipt }))],
        ),
      ),
    },
    {
      id: "admission.recv.legacy-fail-fenced",
      title: "legacy-fail never mutates a receipt past the settle fence (migration 164)",
      prop: prop.never(sel.event("recv.legacy-fail.mutated")),
    },
    {
      id: "admission.upload.foreign-never-deleted",
      title: "foreign objects in the shared bucket are never deleted",
      prop: prop.never(sel.event("upload.foreign.deleted")),
    },
    {
      id: "admission.send.idem-at-most-once",
      title: "an idempotency key never admits a second distinct email",
      prop: prop.optional(
        prop.forEach(
          { name: "idem", discover: sel.event("send.idem.admitted"), key: "/idemKey" },
          (idemKey) => [prop.never(sel.event("send.idem.duplicate", { "/idemKey": idemKey }))],
        ),
      ),
    },
  ],
});
