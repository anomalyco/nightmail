import { anyReply, choice, exact, model, prop, sel, type Choice, type IdleRule, type Step } from "@tear/mbt";
import {
  DISPATCH_PRESETS,
  type CampaignStatus,
  type DispatchAction,
  type DispatchCfg,
  type DispatchObs,
  type DispatchPreset,
  type DispatchSnapshot,
  type MailStatus,
  type Persona,
} from "./dispatch.types.ts";

const LEASE = 120; // sending_emails.lease_until after a lease
const RECOVER = 180; // attempting rows older than this become acceptance_unknown
const PRE_SEND = 5; // a claimed send that cannot start within 5 s is deferred, not sent
const DAY = 86_400;
const SCHEDULE = 60; // schedule launches for now + 60 s
const PENDING_CAP = 10_000; // direct mail queued or attempting per workspace (floor)
const QUOTA_REFRESH = 60; // a dispatcher's quota snapshot is fresh this long
const HEADROOM = 10; // percent of the 24-hour quota kept for transactional mail
const OUTAGE_SECS = 15; // SES outage breaker (commits 3700cf77 & 3c183605): doubles up to 300 s on ambiguous answers
const OUTAGE_MAX_SECS = 300;

type Out = "accepted" | "rejected" | "unknown" | "throttled" | "deferred";

interface MailState {
  name: string;
  p: Persona;
  campaign: boolean;
  st: MailStatus;
  calls: number;
  ver: number;
  due: number;
  dueRacy: boolean;
  lease: number | null;
  attempt: number | null;
  throttles: number;
  interrupted: boolean;
  second: boolean;
  marketing: boolean;
  cost: number;
}

interface CampState {
  st: CampaignStatus;
  total: number;
  prepared: number;
  expanded: number;
  window: number | null;
  windowN: number;
  sched: number | null;
  job: number | null;
  jobRacy: boolean;
}

type InstPhase =
  | { kind: "off" }
  | { kind: "lease" }
  | { kind: "claim"; m: number; prep: number; ver: number }
  | { kind: "ses"; m: number; ver: number }
  | { kind: "record"; m: number; out: Out; ver: number };

interface InstState {
  exists: boolean;
  ph: InstPhase;
  nextSend: number;
  outageUntil: number;
  outageStreak: number;
  finishing: boolean;
}

interface KeyEntry {
  key: string;
  first: Persona;
  mailIndex: number;
}

export interface DispatchState {
  configured: boolean;
  cfg: DispatchCfg | null;
  t: number;
  mails: MailState[];
  camp: CampState;
  keys: KeyEntry[];
  runnerNextSend: number;
  runnerBrakeUntil: number;
  runnerOutageUntil: number;
  runnerOutageStreak: number;
  d: [InstState, InstState];
  directs: number;
  ledger: [number, number][];
  snapshot: { sent: number; at: number } | null;
  sentSince: number;
}

function offInst(): InstState {
  return { exists: false, ph: { kind: "off" }, nextSend: 0, outageUntil: 0, outageStreak: 0, finishing: false };
}

function emptyCamp(total: number): CampState {
  return {
    st: "draft",
    total,
    prepared: 0,
    expanded: 0,
    window: null,
    windowN: 0,
    sched: null,
    job: null,
    jobRacy: false,
  };
}

function initialForPreset(preset: DispatchPreset): DispatchState {
  const cfg = DISPATCH_PRESETS[preset];
  return {
    configured: true,
    cfg,
    t: 0,
    mails: [],
    camp: emptyCamp(cfg.recipients),
    keys: [],
    runnerNextSend: 0,
    runnerBrakeUntil: 0,
    runnerOutageUntil: 0,
    runnerOutageStreak: 0,
    d: [offInst(), offInst()],
    directs: 0,
    ledger: [],
    snapshot: null,
    sentSince: 0,
  };
}

function cloneState(s: DispatchState): DispatchState {
  return structuredClone(s);
}

function stRank(st: MailStatus): number {
  switch (st) {
    case "queued":
      return 0;
    case "attempting":
      return 1;
    case "acceptance_unknown":
      return 2;
    case "accepted":
      return 3;
    case "rejected":
    case "canceled":
      return 6;
  }
}

function csRunning(st: CampaignStatus): boolean {
  return st === "preparing" || st === "scheduled" || st === "sending";
}

function csActive(st: CampaignStatus): boolean {
  return csRunning(st) || st === "paused";
}

function isRacy(s: DispatchState): boolean {
  const t = s.t;
  if (
    s.mails.some(
      (m) =>
        (m.st === "queued" && m.dueRacy && m.due === t) ||
        m.lease === t ||
        (m.st === "attempting" && m.attempt !== null && m.attempt + RECOVER === t),
    )
  ) {
    return true;
  }
  if (s.camp.jobRacy && s.camp.job === t) return true;
  if (s.runnerBrakeUntil > 0 && s.runnerBrakeUntil === t) return true;
  if (s.runnerOutageUntil > 0 && (s.runnerOutageUntil === t || s.runnerOutageUntil === t + PRE_SEND)) return true;
  if (s.d.some((i) => i.outageUntil > 0 && (i.outageUntil === t || i.outageUntil === t + PRE_SEND))) return true;
  if (s.snapshot !== null && s.snapshot.at + QUOTA_REFRESH === t) return true;
  if (s.ledger.some(([at]) => at + DAY === t)) return true;
  if (s.camp.sched === t) return true;
  if (s.camp.window !== null && s.camp.window + DAY === t) return true;
  if (s.d.some((i) => i.ph.kind === "claim" && i.ph.prep + PRE_SEND === t)) return true;
  return false;
}

function isDue(s: DispatchState, m: MailState): boolean {
  return m.st === "queued" && m.due <= s.t && (m.lease === null || m.lease < s.t);
}

function dueOrder(s: DispatchState): number[] {
  const due: number[] = [];
  for (let i = 0; i < s.mails.length; i++) {
    if (isDue(s, s.mails[i]!)) due.push(i);
  }
  due.sort((a, b) => {
    const ma = s.mails[a]!.marketing ? 1 : 0;
    const mb = s.mails[b]!.marketing ? 1 : 0;
    return ma !== mb ? ma - mb : a - b;
  });
  return due;
}

function providerCall(s: DispatchState, i: number): Out {
  const m = s.mails[i]!;
  m.calls += 1;
  let out: Out;
  switch (m.p) {
    case "ok":
      out = "accepted";
      break;
    case "rej":
      out = "rejected";
      break;
    case "unk":
      out = "unknown";
      break;
    case "thr":
      out = m.calls === 1 ? "throttled" : "accepted";
      break;
  }
  if (s.cfg!.exactQuota !== null && (out === "accepted" || out === "unknown")) {
    s.ledger.push([s.t, m.cost]);
  }
  return out;
}

function recordOutcome(s: DispatchState, i: number, out: Out, ver: number, at: number, requeueAt?: number): boolean {
  const m = s.mails[i]!;
  if (m.ver !== ver) return false;
  if (out === "throttled" || out === "deferred") {
    const requeue = m.st === "queued" || m.st === "attempting" || (m.st === "acceptance_unknown" && m.interrupted);
    if (!requeue) return false;
    const reopened = m.st === "acceptance_unknown" && m.campaign;
    m.st = "queued";
    m.ver += 1;
    m.attempt = null;
    m.lease = null;
    m.interrupted = false;
    if (out === "throttled") {
      const backoff = Math.min(2 << m.throttles, 60);
      m.throttles += 1;
      m.due = at + backoff;
      m.dueRacy = true;
    } else if (requeueAt !== undefined && requeueAt > at) {
      m.due = requeueAt;
      m.dueRacy = true;
    } else {
      m.due = at;
      m.dueRacy = false;
    }
    if (reopened && s.camp.st === "done") {
      s.camp.st = "sending";
    }
    return false;
  }
  const next: MailStatus = out === "accepted" ? "accepted" : out === "rejected" ? "rejected" : "acceptance_unknown";
  if (stRank(next) >= stRank(m.st)) {
    m.st = next;
    m.lease = null;
    if (next !== "acceptance_unknown") {
      m.interrupted = false;
    }
  }
  return m.campaign;
}

function finishCampaign(s: DispatchState): void {
  if (
    s.camp.st === "sending" &&
    s.camp.expanded === s.camp.total &&
    !s.mails.some((m) => m.campaign && (m.st === "queued" || m.st === "attempting"))
  ) {
    s.camp.st = "done";
  }
}

function claimRow(s: DispatchState, i: number, ver: number): boolean | null {
  const m = s.mails[i]!;
  if (m.st !== "queued" || m.ver !== ver) return null;
  m.lease = null;
  if (m.campaign && s.camp.st === "canceled") {
    m.st = "canceled";
    return false;
  }
  m.st = "attempting";
  m.attempt = s.t;
  return true;
}

function fairPage(
  s: DispatchState,
  batch: number,
  marketing: number | null,
  transactional: number | null,
  priority: boolean,
): number[] {
  const turns: [number, number, number][] = [];
  for (const second of [false, true]) {
    let turn = 0;
    for (const i of dueOrder(s)) {
      const m = s.mails[i]!;
      if (m.second !== second) continue;
      const cap = m.marketing ? marketing : transactional;
      if ((m.marketing && priority) || (cap !== null && m.cost > cap)) continue;
      turns.push([turn, m.marketing ? 1 : 0, i]);
      turn += 1;
    }
  }
  turns.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] !== b[1] ? a[1] - b[1] : a[2] - b[2]));
  const page = turns.slice(0, batch).map((t) => t[2]);
  page.sort((a, b) => {
    const ma = s.mails[a]!.marketing ? 1 : 0;
    const mb = s.mails[b]!.marketing ? 1 : 0;
    return ma !== mb ? ma - mb : a - b;
  });
  return page;
}

function drainQuota(s: DispatchState, q: number): void {
  const reserve = Math.floor((q * HEADROOM + 99) / 100);
  const batch = s.cfg!.drainBatch;
  let fresh = s.snapshot !== null && s.t < s.snapshot.at + QUOTA_REFRESH;
  const left = (marketing: boolean): number => {
    const sent = s.snapshot?.sent ?? 0;
    const room = q - sent - s.sentSince;
    return marketing ? Math.max(0, q - sent - reserve) - s.sentSince : room;
  };
  let finishing = false;
  for (;;) {
    let priority = false;
    if (fresh && left(true) <= 0) {
      if (left(false) <= 0) break;
      priority = true;
    }
    const marketing = fresh ? Math.max(0, left(true)) : null;
    const transactional = fresh ? Math.max(0, left(false)) : null;
    const rows = fairPage(s, batch, marketing, transactional, priority);
    if (rows.length === 0) break;
    for (const i of rows) s.mails[i]!.lease = s.t + LEASE;
    if (!fresh) {
      const sent = s.ledger.filter(([at]) => at + DAY > s.t).reduce((acc, [, n]) => acc + n, 0);
      s.snapshot = { sent, at: s.t };
      s.sentSince = 0;
      fresh = true;
    }
    if (left(false) <= 0) {
      for (const i of rows) s.mails[i]!.lease = null;
      break;
    }
    const retry = Math.max(s.t + 1, s.snapshot ? s.snapshot.at + QUOTA_REFRESH : 0);
    let claims = 0;
    for (let g = 0; g < rows.length; g += 6) {
      const group = rows.slice(g, g + 6);
      let held = 0;
      const claimed: [number, number][] = [];
      for (const i of group) {
        const m = s.mails[i]!;
        if (m.cost <= left(m.marketing) - held) {
          held += m.cost;
          claims += 1;
          const ver = m.ver;
          if (claimRow(s, i, ver) === true) {
            claimed.push([i, ver]);
          }
        } else {
          m.lease = m.marketing ? null : retry;
        }
      }
      for (const [i, ver] of claimed) {
        s.sentSince += s.mails[i]!.cost;
        const out = providerCall(s, i);
        if (recordOutcome(s, i, out, ver, s.t)) finishing = true;
      }
    }
    if (rows.length < batch) break;
    if (claims === 0 && marketing !== null) break;
  }
  if (finishing) finishCampaign(s);
}

function drainRunner(s: DispatchState): void {
  if (s.cfg!.exactQuota !== null) {
    drainQuota(s, s.cfg!.exactQuota);
    return;
  }
  let finishing = false;
  for (;;) {
    if (s.runnerNextSend >= s.t + PRE_SEND) break;
    const batch = s.cfg!.drainBatch;
    const rows = dueOrder(s).slice(0, batch);
    if (rows.length === 0) break;
    for (const i of rows) s.mails[i]!.lease = s.t + LEASE;
    for (let g = 0; g < rows.length; g += 6) {
      const group = rows.slice(g, g + 6);
      if (s.runnerNextSend >= s.t + PRE_SEND) {
        for (const i of group) s.mails[i]!.lease = null;
        continue;
      }
      const prep = s.t;
      const claimed: [number, number][] = [];
      for (const i of group) {
        const ver = s.mails[i]!.ver;
        if (claimRow(s, i, ver) === true) claimed.push([i, ver]);
      }
      const outcomes: [number, Out, number, number, number | undefined][] = [];
      let firstStart: number | null = null;
      // idx=0 and a transactional idx=1 launch synchronously in the same pump() turn before idx=0's
      // response settles, whenever the gate is neither braked nor in outage-probe mode at idx=0's start.
      let secondInFlight = false;
      for (let idx = 0; idx < claimed.length; idx++) {
        const [i, ver] = claimed[idx]!;
        const early = idx === 1 && !s.mails[i]!.marketing && secondInFlight && firstStart !== null;
        const start = early ? firstStart! : Math.max(s.t, s.runnerNextSend);
        if (idx === 0) {
          firstStart = start;
          secondInFlight = s.runnerBrakeUntil <= start && s.runnerOutageStreak === 0;
        }
        if (start >= prep + PRE_SEND) {
          const requeueAt = s.runnerOutageUntil > s.t ? s.runnerOutageUntil : undefined;
          outcomes.push([i, "deferred", ver, s.t, requeueAt]);
          continue;
        }
        s.t = Math.max(s.t, start);
        const out = providerCall(s, i);
        if (out === "accepted") {
          s.runnerOutageStreak = 0;
        } else if (out === "throttled") {
          s.runnerNextSend = Math.max(s.runnerNextSend, start + 1);
          s.runnerBrakeUntil = Math.max(s.runnerBrakeUntil, start + 10);
        } else if (out === "unknown" && s.runnerOutageUntil <= start) {
          const wait = Math.min(OUTAGE_MAX_SECS, OUTAGE_SECS * 2 ** s.runnerOutageStreak);
          s.runnerOutageUntil = start + wait;
          s.runnerOutageStreak += 1;
          s.runnerNextSend = Math.max(s.runnerNextSend, s.runnerOutageUntil);
          s.runnerBrakeUntil = Math.max(s.runnerBrakeUntil, s.runnerOutageUntil);
        }
        outcomes.push([i, out, ver, start, undefined]);
      }
      for (const [i, out, ver, at, requeueAt] of outcomes) {
        if (recordOutcome(s, i, out, ver, at, requeueAt)) finishing = true;
      }
    }
    if (rows.length < batch) break;
  }
  if (finishing) finishCampaign(s);
}

function stepInst(s: DispatchState, k: 0 | 1): void {
  const inst = s.d[k];
  const ph = inst.ph;
  inst.exists = true;
  const enterLease = () => {
    if (inst.nextSend >= s.t + PRE_SEND) {
      if (inst.finishing) finishCampaign(s);
      inst.ph = { kind: "off" };
    } else {
      inst.ph = { kind: "lease" };
    }
  };
  switch (ph.kind) {
    case "off":
      inst.finishing = false;
      enterLease();
      break;
    case "lease": {
      const first = dueOrder(s)[0];
      if (first === undefined) {
        if (inst.finishing) finishCampaign(s);
        inst.ph = { kind: "off" };
      } else {
        s.mails[first]!.lease = s.t + LEASE;
        inst.ph = { kind: "claim", m: first, prep: s.t, ver: s.mails[first]!.ver };
      }
      break;
    }
    case "claim": {
      const res = claimRow(s, ph.m, ph.ver);
      if (res === true) {
        const start = Math.max(s.t, inst.nextSend);
        if (start >= ph.prep + PRE_SEND) {
          inst.ph = { kind: "record", m: ph.m, out: "deferred", ver: ph.ver };
        } else {
          s.t = start;
          inst.ph = { kind: "ses", m: ph.m, ver: ph.ver };
        }
      } else {
        enterLease();
      }
      break;
    }
    case "ses": {
      const out = providerCall(s, ph.m);
      if (out === "accepted") {
        inst.outageStreak = 0;
      } else if (out === "throttled") {
        inst.nextSend = Math.max(inst.nextSend, s.t + 1);
      } else if (out === "unknown" && inst.outageUntil <= s.t) {
        const wait = Math.min(OUTAGE_MAX_SECS, OUTAGE_SECS * 2 ** inst.outageStreak);
        inst.outageUntil = s.t + wait;
        inst.outageStreak += 1;
        inst.nextSend = Math.max(inst.nextSend, inst.outageUntil);
      }
      inst.ph = { kind: "record", m: ph.m, out, ver: ph.ver };
      break;
    }
    case "record": {
      const requeueAt = ph.out === "deferred" && inst.outageUntil > s.t ? inst.outageUntil : undefined;
      if (recordOutcome(s, ph.m, ph.out, ph.ver, s.t, requeueAt)) inst.finishing = true;
      enterLease();
      break;
    }
  }
}

function recoverAttempts(s: DispatchState): void {
  for (const m of s.mails) {
    if (m.st === "attempting" && m.attempt !== null && m.attempt + RECOVER < s.t) {
      m.st = "acceptance_unknown";
      m.interrupted = true;
      m.lease = null;
    }
  }
  finishCampaign(s);
}

function pendingCount(s: DispatchState): number {
  return (
    s.cfg!.seed +
    s.mails.filter((m) => !m.campaign && !m.second && (m.st === "queued" || m.st === "attempting")).length
  );
}

function admitAs(s: DispatchState, p: Persona, second: boolean): [number, string] {
  if (!second && pendingCount(s) + 1 > PENDING_CAP) {
    return [429, "PENDING_EMAIL_LIMIT_EXCEEDED"];
  }
  s.directs += 1;
  const name = `e${s.directs}`;
  s.mails.push({
    name,
    p,
    campaign: false,
    st: "queued",
    calls: 0,
    ver: 0,
    due: s.t,
    dueRacy: false,
    lease: null,
    attempt: null,
    throttles: 0,
    interrupted: false,
    second,
    marketing: false,
    cost: 1,
  });
  return [202, name];
}

function admitMarketing(s: DispatchState, cost: 1 | 2, second: boolean): [number, string] {
  const reply = admitAs(s, "ok", second);
  if (reply[0] === 202) {
    const m = s.mails[s.mails.length - 1]!;
    m.marketing = true;
    m.cost = cost;
  }
  return reply;
}

function admitKey(s: DispatchState, key: string, p: Persona): [number, string] {
  const existing = s.keys.find((e) => e.key === key);
  if (existing) {
    return existing.first === p ? [202, s.mails[existing.mailIndex]!.name] : [409, "IDEMPOTENCY_CONFLICT"];
  }
  const reply = admitAs(s, p, false);
  if (reply[0] === 202) {
    s.keys.push({ key, first: p, mailIndex: s.mails.length - 1 });
  }
  return reply;
}

function runningState(s: DispatchState): CampaignStatus {
  const c = s.camp;
  if (c.prepared < c.total) return "preparing";
  if (c.sched !== null && c.sched > s.t) return "scheduled";
  return "sending";
}

function launchCampaign(s: DispatchState, scheduled: boolean): [number, string | null] {
  if (s.camp.st !== "draft") return [409, "CAMPAIGN_LOCKED"];
  s.camp.st = "preparing";
  s.camp.prepared = 0;
  s.camp.expanded = 0;
  s.camp.window = null;
  s.camp.windowN = 0;
  s.camp.sched = scheduled ? s.t + SCHEDULE : null;
  s.camp.job = s.t;
  s.camp.jobRacy = false;
  return [202, null];
}

function pauseCampaign(s: DispatchState): [number, string | null] {
  if (!csActive(s.camp.st)) return [409, "CAMPAIGN_NOT_SENDING"];
  if (s.camp.st === "paused" || s.camp.expanded >= s.camp.total) return [409, "CAMPAIGN_NOT_PAUSABLE"];
  s.camp.st = "paused";
  s.camp.job = null;
  return [200, null];
}

function resumeCampaign(s: DispatchState): [number, string | null] {
  if (!csActive(s.camp.st)) return [409, "CAMPAIGN_NOT_SENDING"];
  if (s.camp.st !== "paused") return [409, "CAMPAIGN_NOT_PAUSED"];
  const next = runningState(s);
  s.camp.st = next;
  if (next === "scheduled") {
    s.camp.job = s.camp.sched;
    s.camp.jobRacy = true;
  } else {
    s.camp.job = s.t;
    s.camp.jobRacy = false;
  }
  return [200, null];
}

function cancelCampaign(s: DispatchState): [number, string | number] | [number, number, number] {
  if (s.camp.st === "done") return [409, "CAMPAIGN_ALREADY_DISPATCHED"];
  if (s.camp.st === "draft") return [409, "CAMPAIGN_NOT_SENDING"];
  const moved = s.camp.st !== "canceled";
  let canceled = 0;
  if (moved) {
    canceled += s.camp.total - s.camp.expanded;
    s.camp.st = "canceled";
    s.camp.job = null;
    for (const m of s.mails) {
      if (m.campaign && m.st === "queued") {
        m.st = "canceled";
        m.lease = null;
        canceled += 1;
      }
    }
  }
  const inFlight = s.mails.filter(
    (m) => m.campaign && (m.st === "attempting" || m.st === "accepted" || m.st === "acceptance_unknown"),
  ).length;
  return [200, canceled, inFlight];
}

function runJobs(s: DispatchState): void {
  if (s.camp.job === null || s.camp.job > s.t) return;
  s.camp.job = null;
  for (;;) {
    const t = s.t;
    switch (s.camp.st) {
      case "preparing":
        s.camp.prepared = s.camp.total;
        s.camp.st = runningState(s);
        break;
      case "scheduled": {
        const at = s.camp.sched ?? t;
        if (at > t) {
          s.camp.job = at;
          s.camp.jobRacy = true;
          return;
        }
        s.camp.st = "sending";
        break;
      }
      case "sending": {
        const c = s.camp;
        if (c.expanded >= c.total) return;
        const pace = s.cfg!.pace;
        const newWindow = pace !== null && (c.window === null || t >= c.window + DAY);
        const win = newWindow ? t : c.window;
        const used = newWindow ? 0 : c.windowN;
        const left = pace === null ? 255 : Math.max(0, pace - used);
        if (left === 0) {
          c.job = win !== null ? win + DAY : null;
          c.jobRacy = true;
          return;
        }
        const n = Math.min(left, c.total - c.expanded);
        for (let i = 0; i < n; i++) {
          c.expanded += 1;
          const count = s.mails.filter((m) => m.campaign).length + 1;
          s.mails.push({
            name: `c${count}`,
            p: s.cfg!.campaign,
            campaign: true,
            st: "queued",
            calls: 0,
            ver: 0,
            due: t,
            dueRacy: false,
            lease: null,
            attempt: null,
            throttles: 0,
            interrupted: false,
            second: false,
            marketing: true,
            cost: 1,
          });
        }
        c.window = win;
        c.windowN = used + n;
        if (c.expanded === c.total) return;
        break;
      }
      default:
        return;
    }
  }
}

function buildExpected(s: DispatchState, r: unknown): DispatchObs {
  if (s.cfg!.quota !== null) return { invariants: true };
  const mail: Record<string, [string, number]> = {};
  for (const m of s.mails) {
    mail[m.name] = [m.st, m.calls];
  }
  const d: Record<string, string> = {};
  for (let k = 0; k < 2; k++) {
    const inst = s.d[k]!;
    if (!inst.exists) continue;
    let ph: string;
    switch (inst.ph.kind) {
      case "off":
        ph = "off";
        break;
      case "lease":
        ph = "lease";
        break;
      case "claim":
        ph = `claim ${s.mails[inst.ph.m]!.name}`;
        break;
      case "ses":
        ph = `ses ${s.mails[inst.ph.m]!.name}`;
        break;
      case "record":
        ph = `record ${s.mails[inst.ph.m]!.name}`;
        break;
    }
    d[`D${k + 1}`] = ph;
  }
  return {
    r: r === undefined ? null : r,
    mail,
    campaign: [s.camp.st, s.camp.expanded, s.camp.windowN],
    d,
  };
}

function readsTime(s: DispatchState, a: DispatchAction): boolean {
  switch (a.op) {
    case "Configure":
    case "Wait":
    case "Send":
    case "SendKey":
    case "DupKey":
    case "Pause":
    case "Cancel":
    case "Crash":
      return false;
    case "Step": {
      const k = a.inst === "D2" ? 1 : 0;
      const kind = s.d[k]!.ph.kind;
      return kind === "off" || kind === "lease" || kind === "claim" || kind === "record";
    }
    default:
      return true;
  }
}

function isEnabled(s: DispatchState, a: DispatchAction): boolean {
  if (!s.configured) return a.op === "Configure";
  if (a.op === "Configure") return false;
  if (s.cfg!.quota !== null) return true;
  if (readsTime(s, a) && isRacy(s)) return false;
  if (a.op === "Crash") {
    const k = a.inst === "D2" ? 1 : 0;
    return s.d[k]!.ph.kind !== "off";
  }
  return true;
}

function actionWeight(a: DispatchAction): number {
  switch (a.op) {
    case "Step":
      return 5;
    case "Jobs":
    case "Drain":
    case "Recover":
    case "Pause":
    case "Resume":
    case "Cancel":
      return 2;
    case "Wait":
      return a.seconds === 1 || a.seconds === 60 ? 2 : 1;
    default:
      return 1;
  }
}

function alphabetForPreset(preset: DispatchPreset): DispatchAction[] {
  const baseWaits: DispatchAction[] = [
    { op: "Wait", seconds: 1 },
    { op: "Wait", seconds: 60 },
  ];
  switch (preset) {
    case "owners":
      return [
        ...baseWaits,
        { op: "Send", persona: "ok" },
        { op: "Send2", persona: "ok" },
        { op: "Drain" },
        { op: "Recover" },
      ];
    case "allowance":
      return [
        ...baseWaits,
        { op: "Wait", seconds: 59 },
        { op: "Wait", seconds: 86400 },
        { op: "SendMarketing", cost: 1, second: false },
        { op: "SendMarketing", cost: 2, second: false },
        { op: "Send", persona: "ok" },
        { op: "Drain" },
      ];
    case "allowance2":
      return [
        ...baseWaits,
        { op: "Wait", seconds: 59 },
        { op: "Wait", seconds: 86400 },
        { op: "SendMarketing", cost: 1, second: false },
        { op: "SendMarketing", cost: 2, second: false },
        { op: "SendMarketing", cost: 1, second: true },
        { op: "SendMarketing", cost: 2, second: true },
        { op: "Send", persona: "ok" },
        { op: "Send2", persona: "ok" },
        { op: "Drain" },
      ];
    case "quota2":
    case "quota3":
    case "quota4":
      return [
        ...baseWaits,
        { op: "Wait", seconds: 86400 },
        { op: "Send", persona: "ok" },
        { op: "Send", persona: "unk" },
        { op: "Launch" },
        { op: "Jobs" },
        { op: "Step", inst: "D1" },
        { op: "Step", inst: "D2" },
        { op: "Crash", inst: "D1" },
        { op: "Crash", inst: "D2" },
        { op: "Recover" },
        { op: "Settle" },
        { op: "SesPause", paused: true },
        { op: "SesPause", paused: false },
      ];
    default:
      // core, paced, throttle, pendingCap: full dispatch + campaign + admission alphabet
      return [
        ...baseWaits,
        { op: "Wait", seconds: 4 },
        { op: "Wait", seconds: 59 },
        { op: "Wait", seconds: 86400 },
        { op: "Send", persona: "ok" },
        { op: "Send", persona: "thr" },
        { op: "Send", persona: "rej" },
        { op: "Send", persona: "unk" },
        { op: "SendKey", key: "k1", persona: "ok" },
        { op: "SendKey", key: "k1", persona: "rej" },
        { op: "SendKey", key: "k2", persona: "ok" },
        { op: "SendKey", key: "k2", persona: "rej" },
        { op: "DupKey", key: "k2", persona: "ok" },
        { op: "Launch" },
        { op: "Schedule" },
        { op: "Pause" },
        { op: "Resume" },
        { op: "Cancel" },
        { op: "Jobs" },
        { op: "Drain" },
        { op: "Recover" },
        { op: "Step", inst: "D1" },
        { op: "Crash", inst: "D1" },
        { op: "Step", inst: "D2" },
        { op: "Crash", inst: "D2" },
      ];
  }
}

// ---- Idle rules: the 4 quantitative temporal rules + all host-independent safety invariants ----

const dispatchIdleRules: IdleRule<DispatchSnapshot>[] = [
  // Temporal rule 1 of 5 (dispatch.once is declarative below):
  // brake: a throttled process waits 1 s (990 ms tolerance) before its next provider call.
  {
    id: "dispatch.brake",
    description: "a throttled process waits 1 s before its next provider call",
    when: (s) => s.configured && s.sendLog.some((e) => e.out === "braked"),
    optional: true,
    check(s) {
      const byProc = new Map<string, number>();
      for (const e of s.sendLog) {
        const pendingSince = byProc.get(e.proc);
        if (pendingSince !== undefined) {
          if (e.out === "braked") {
            const nextSince = e.since ?? e.at;
            if (nextSince < pendingSince) {
              return `proc ${e.proc}: braked marker went backwards (${nextSince} < ${pendingSince})`;
            }
            byProc.set(e.proc, nextSince);
            continue;
          }
          if (e.at < pendingSince + 990) {
            return `proc ${e.proc}: next send (${e.mail}, ${e.out}) ran ${e.at - pendingSince}ms after brake (need >= 990ms)`;
          }
          byProc.delete(e.proc);
        }
        if (e.out === "braked") {
          byProc.set(e.proc, e.since ?? e.at);
        }
      }
      return undefined;
    },
  },
  // Temporal rule 2 of 5: backoff: a throttled row waits 2 s (1990 ms tolerance) before retry.
  {
    id: "dispatch.backoff",
    description: "a throttled row waits 2 s before retry",
    when: (s) => s.configured && s.sendLog.some((e) => e.out === "throttled"),
    optional: true,
    check(s) {
      const lastThrottle = new Map<string, number>();
      for (const e of s.sendLog) {
        if (!e.mail) continue;
        const prev = lastThrottle.get(e.mail);
        if (prev !== undefined) {
          if (e.at < prev + 1990) {
            return `mail ${e.mail}: retried ${e.at - prev}ms after throttle (need >= 1990ms)`;
          }
          lastThrottle.delete(e.mail);
        }
        if (e.out === "throttled") {
          lastThrottle.set(e.mail, e.at);
        }
      }
      return undefined;
    },
  },
  // Temporal rule 3 of 5: pace: a window never exceeds its daily cap.
  {
    id: "dispatch.pace.cap",
    description: "a pacing window never exceeds its daily cap",
    when: (s) => s.configured && s.releaseLog.some((e) => e.pace !== null),
    optional: true,
    check(s) {
      for (const e of s.releaseLog) {
        if (e.pace !== null && e.windowN > e.pace) {
          return `campaign released ${e.windowN} in window, exceeding daily cap ${e.pace}`;
        }
      }
      return undefined;
    },
  },
  // Temporal rule 4 of 5: pace: a full window holds until 24 h after windowStart.
  {
    id: "dispatch.pace.window",
    description: "a full pacing window holds the next release until it ends (24 h)",
    when: (s) => s.configured && s.releaseLog.some((e) => e.pace !== null && e.windowN >= e.pace),
    optional: true,
    check(s) {
      let heldUntil: number | null = null;
      for (const e of s.releaseLog) {
        if (heldUntil !== null) {
          if (e.at < heldUntil) {
            return `release at ${e.at} broke full-window hold until ${heldUntil}`;
          }
          heldUntil = null;
        }
        if (e.pace !== null && e.windowN >= e.pace && e.windowStart !== null) {
          heldUntil = e.windowStart + 86_400_000;
        }
      }
      return undefined;
    },
  },
  // Safety invariants (checked independently of model reply predictions):
  {
    id: "dispatch.no-double-send",
    description: "no email is ever accepted by SES more than once",
    when: (s) => s.configured,
    check: (s) => (s.doubleSends.length ? `double-send: ${s.doubleSends.join(", ")}` : undefined),
  },
  {
    id: "dispatch.no-leaked-errors",
    description: "no unhandled rejections or uncaught exceptions in the host",
    when: (s) => s.configured,
    check: (s) => (s.leakedErrors.length ? `leaked: ${s.leakedErrors.join("; ")}` : undefined),
  },
  {
    id: "dispatch.no-sent-after-cancel",
    description: "no campaign email queued at cancel is later sent",
    when: (s) => s.configured,
    check: (s) => (s.sentAfterCancel.length ? `sent-after-cancel: ${s.sentAfterCancel.join(", ")}` : undefined),
  },
  {
    id: "dispatch.no-unknown-ses-email",
    description: "SES never receives an unknown email id",
    when: (s) => s.configured,
    check: (s) => (s.unknownSesEmails.length ? `ses-unknown: ${s.unknownSesEmails.join(", ")}` : undefined),
  },
  {
    id: "dispatch.stream-depth",
    description: "sending_stream_depth matches queued/attempting direct rows plus seed",
    when: (s) => s.configured,
    check: (s) =>
      s.depth !== s.queued + s.seed ? `depth ${s.depth} != queued ${s.queued} + seed ${s.seed}` : undefined,
  },
  {
    id: "dispatch.quota-cap",
    description: "24-hour accepted sends never exceed the SES daily quota",
    when: (s) => s.configured && s.quota >= 0,
    optional: true,
    check: (s) =>
      s.withinDay > s.quota ? `withinDay ${s.withinDay} exceeded quota ${s.quota}` : undefined,
  },
  {
    id: "dispatch.transactional-reserve",
    description: "marketing sends never spend the 10% transactional reserve",
    when: (s) => s.configured && s.quota > 0,
    optional: true,
    check(s) {
      const reserve = Math.ceil((s.quota * HEADROOM) / 100);
      const allowed = s.quota - reserve;
      return s.marketingWithinDay > allowed
        ? `marketing ${s.marketingWithinDay} exceeded quota-reserve ${allowed} (quota=${s.quota})`
        : undefined;
    },
  },
  {
    id: "dispatch.pause-expired-not-early",
    description: "a row is given up as SES_ACCOUNT_PAUSE_EXPIRED only 24 h after its first pause refusal",
    when: (s) => s.configured,
    check: (s) =>
      s.pauseExpiredEarly.length ? `pause-expired-early: ${s.pauseExpiredEarly.join(", ")}` : undefined,
  },
  {
    id: "dispatch.no-spin",
    description: "a drain run never spins on leases without claiming rows",
    when: (s) => s.configured,
    check: (s) => (s.spins.length ? `spin: ${s.spins.join("; ")}` : undefined),
  },
  {
    id: "dispatch.no-asleep-with-due",
    description: "an idle drain with untried due mail must schedule a retry wake",
    when: (s) => s.configured,
    check: (s) =>
      s.asleepWithDue.length ? `asleep-with-mail-due: ${s.asleepWithDue.join("; ")}` : undefined,
  },
  {
    id: "dispatch.no-stuck-after-settle",
    description: "every admitted row settles once the provider accepts mail again",
    when: (s) => s.configured,
    check: (s) =>
      s.stuckAfterSettle.length ? `stuck: ${s.stuckAfterSettle.join(", ")}` : undefined,
  },
  {
    id: "dispatch.no-dispatcher-error",
    description: "no unexpected dispatcher errors",
    when: (s) => s.configured,
    check: (s) =>
      s.dispatcherErrors.length ? `dispatcher-error: ${s.dispatcherErrors.join("; ")}` : undefined,
  },
];

export const dispatch = model<DispatchState, DispatchAction, DispatchObs, DispatchSnapshot>({
  id: "dispatch",
  description: "Nightmail send path: admission, campaigns, batch dispatcher, quotas, retries and recovery",
  maxSteps: 24,
  bug: "canary_double_send",

  initial: () => ({
    configured: false,
    cfg: null,
    t: 0,
    mails: [],
    camp: emptyCamp(0),
    keys: [],
    runnerNextSend: 0,
    runnerBrakeUntil: 0,
    runnerOutageUntil: 0,
    runnerOutageStreak: 0,
    d: [offInst(), offInst()],
    directs: 0,
    ledger: [],
    snapshot: null,
    sentSince: 0,
  }),

  choices(s): Choice<DispatchAction>[] {
    if (!s.configured) {
      return [
        choice({ op: "Configure", preset: "core" }, 4),
        choice({ op: "Configure", preset: "paced" }, 2),
        choice({ op: "Configure", preset: "throttle" }, 2),
        choice({ op: "Configure", preset: "pendingCap" }, 2),
        choice({ op: "Configure", preset: "owners" }, 2),
        choice({ op: "Configure", preset: "allowance" }, 2),
        choice({ op: "Configure", preset: "allowance2" }, 2),
        choice({ op: "Configure", preset: "quota2" }, 1),
        choice({ op: "Configure", preset: "quota3" }, 1),
        choice({ op: "Configure", preset: "quota4" }, 1),
      ];
    }
    const out: Choice<DispatchAction>[] = [];
    for (const a of alphabetForPreset(s.cfg!.preset)) {
      if (isEnabled(s, a)) {
        out.push(choice(a, actionWeight(a)));
      }
    }
    return out;
  },

  step(s, a): Step<DispatchState, DispatchObs> {
    if (a.op === "Configure") {
      const next = initialForPreset(a.preset);
      return {
        next,
        expect: next.cfg!.quota !== null ? anyReply() : exact(buildExpected(next, null)),
      };
    }

    const next = cloneState(s);
    if (next.cfg!.quota !== null) {
      if (a.op === "Wait") next.t += a.seconds;
      else if (a.op === "Settle") next.t += 7 * (DAY + 60);
      return { next, expect: anyReply() };
    }

    let r: unknown = null;
    switch (a.op) {
      case "Wait":
        next.t += a.seconds;
        break;
      case "Send":
        r = [admitAs(next, a.persona, false)];
        break;
      case "Send2":
        r = [admitAs(next, a.persona, true)];
        break;
      case "SendMarketing":
        r = [admitMarketing(next, a.cost, a.second)];
        break;
      case "SendKey":
        r = [admitKey(next, a.key, a.persona)];
        break;
      case "DupKey": {
        const first = admitKey(next, a.key, a.persona);
        const second = admitKey(next, a.key, a.persona);
        r = [first, second];
        break;
      }
      case "Launch":
        r = launchCampaign(next, false);
        break;
      case "Schedule":
        r = launchCampaign(next, true);
        break;
      case "Pause":
        r = pauseCampaign(next);
        break;
      case "Resume":
        r = resumeCampaign(next);
        break;
      case "Cancel":
        r = cancelCampaign(next);
        break;
      case "Jobs":
        runJobs(next);
        break;
      case "Drain":
        drainRunner(next);
        if (next.cfg!.exactQuota !== null) r = true;
        break;
      case "Recover":
        recoverAttempts(next);
        break;
      case "Step":
        stepInst(next, a.inst === "D2" ? 1 : 0);
        break;
      case "Crash": {
        const k = a.inst === "D2" ? 1 : 0;
        next.d[k] = { ...offInst(), exists: true };
        break;
      }
      case "Settle":
      case "SesPause":
        break;
    }

    return { next, expect: exact(buildExpected(next, r)) };
  },

  idle: dispatchIdleRules,

  // Temporal rule 5 of 5 (declarative): a possibly accepted row (accepted or 5xx unknown) is never resent.
  temporal: [
    {
      id: "dispatch.once",
      title: "a possibly accepted row is never resent",
      prop: prop.optional(
        prop.forEach(
          { name: "mail", discover: sel.event("send.committed"), key: "/mail" },
          (mail) => [prop.never(sel.event("send.call", { "/mail": mail }))],
        ),
      ),
    },
  ],
});
