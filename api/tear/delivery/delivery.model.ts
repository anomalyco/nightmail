import {
  check,
  choice,
  exact,
  model,
  prop,
  sel,
  type Choice,
  type IdleRule,
  type Step,
  type TemporalProperty,
} from "@tear/mbt";
import {
  DELIVERY_PRESETS,
  ENDPOINTS,
  MSG_VARIANTS,
  RESPONSES,
  RITUAL_MODES,
  WORKERS,
  emailOf,
  epOfDelivery,
  isKeyed,
  isPlainSub,
  isReplaySafe,
  maxAttemptsFor,
  type DeliveryAction,
  type DeliveryObs,
  type DeliveryPreset,
  type DeliveryRowView,
  type DeliverySnapshot,
  type DeliveryView,
  type EndpointName,
  type MsgVariant,
  type RateEndpointName,
  type RcptKey,
  type RitualMode,
  type RouteName,
  type RouteState,
  type SendTuple,
  type WorkerName,
} from "./delivery.types.ts";

interface EpState {
  paused: boolean;
  declined: boolean;
  perMinute: number;
  used: number;
  /** Consecutive transport timeouts (the per-URL breaker in postWebhook). */
  timeouts: number;
}

interface RouteStateRec {
  enabled: boolean;
  drop: boolean;
  to: EndpointName[];
}

interface JobState {
  status: string;
  attempts: number;
  expired: boolean;
}

interface DeliveryRec {
  label: string;
  ep: EndpointName;
  msg: string;
  status: string;
  count: number;
  err: string | null;
  fence: string | null;
  job: JobState | null;
  delay: number | "d" | null;
  /** Attempts the fence let through, recorded or not. */
  tries: number;
  /** Bumped by every resume; a claim belongs to one generation. */
  generation: number;
  /** Created more than the 30-day delivery retention ago (Age). */
  aged: boolean;
  /** Dead-lettered by the sweep after being held past retention (kept 7 more days). */
  expiredHold: boolean;
}

type WorkerState =
  | { kind: "idle" }
  | { kind: "parked"; d: string; attempts: number; stale: boolean; hook: boolean; generation: number }
  | { kind: "flight"; d: string; attempts: number; stale: boolean; ep: EndpointName; generation: number };

interface MsgState {
  /** Recipients the stored message was routed for (its envelope). */
  rcpts: RcptKey[];
  variant: MsgVariant;
  /** The receipt that stored the email first; deliveries carry its message ID. */
  stored: string | null;
  /** Stripped of ingest-time forwardEligible verdict (commit aea1c250 / migration 332 refuses missing verdict). */
  stripped: boolean;
}

export interface DeliveryState {
  configured: boolean;
  retries: number;
  routes: Record<RouteName, RouteStateRec>;
  ritual: RitualMode;
  eps: Partial<Record<EndpointName, EpState>>;
  /** Receipts by SES label (m1, d1, ...). */
  receipts: Record<string, RcptKey[]>;
  /** Emails by message label (dN is the same email as mN). */
  emails: Record<string, MsgState>;
  ds: DeliveryRec[];
  workers: Record<WorkerName, WorkerState>;
  boxed: Record<string, string[]>;
  forwards: string[];
  forwardSends: number;
  /** (email, endpoint) pairs routing or a ritual queued: none may be lost while its endpoint exists. */
  routed: [string, string][];
  /** Pairs whose settled delivery the retention sweep removed. */
  pruned: [string, string][];
}

function emptyState(): DeliveryState {
  return {
    configured: false,
    retries: 1,
    routes: {
      r1: { enabled: true, drop: false, to: ["W"] },
      r2: { enabled: true, drop: false, to: ["W", "V"] },
      r3: { enabled: true, drop: false, to: ["V"] },
    },
    ritual: "none",
    eps: {},
    receipts: {},
    emails: {},
    ds: [],
    workers: { K: { kind: "idle" }, L: { kind: "idle" } },
    boxed: {},
    forwards: [],
    forwardSends: 0,
    routed: [],
    pruned: [],
  };
}

function initialForPreset(preset: DeliveryPreset): DeliveryState {
  const { retries } = DELIVERY_PRESETS[preset];
  const ep = (): EpState => ({ paused: false, declined: false, perMinute: 60, used: 0, timeouts: 0 });
  return {
    configured: true,
    retries,
    routes: {
      r1: { enabled: true, drop: false, to: ["W"] },
      r2: { enabled: true, drop: false, to: ["W", "V"] },
      r3: { enabled: true, drop: false, to: ["V"] },
    },
    ritual: "none",
    eps: { W: ep(), V: ep(), S: ep(), F: ep(), U: ep() },
    receipts: {},
    emails: {},
    ds: [],
    workers: { K: { kind: "idle" }, L: { kind: "idle" } },
    boxed: {},
    forwards: [],
    forwardSends: 0,
    routed: [],
    pruned: [],
  };
}

function cloneState(s: DeliveryState): DeliveryState {
  return structuredClone(s);
}

/** Which endpoints a ritual mode calls from box@, in call order (the call index is the position). */
function ritualCalls(mode: RitualMode): [EndpointName, number][] {
  switch (mode) {
    case "slack":
    case "max":
      return [["S", 0]];
    case "forward":
      return [["F", 0]];
    case "both":
      return [
        ["S", 0],
        ["F", 1],
      ];
    // At most three calls per endpoint per message: the fourth is skipped with a warning.
    case "four":
      return [
        ["S", 0],
        ["S", 1],
        ["S", 2],
      ];
    default:
      return [];
  }
}

function retryAfterMs(arg: string | undefined): number {
  if (arg !== undefined && /^\d+$/.test(arg)) {
    return Math.min(Number(arg) * 1000, 7 * 86_400_000);
  }
  return 0;
}

function backoffSeconds(attempt: number, afterMs: number): number {
  const exp = Math.min(Math.max(attempt - 1, 0), 10);
  const base = Math.min(15_000 * Math.pow(4, exp), 12 * 3_600_000);
  return Math.floor(Math.max(base, afterMs) / 1000);
}

function findDelivery(s: DeliveryState, label: string): DeliveryRec | undefined {
  return s.ds.find((d) => d.label === label);
}

function markStale(s: DeliveryState, label: string): void {
  for (const w of WORKERS) {
    const wk = s.workers[w];
    if ((wk.kind === "parked" || wk.kind === "flight") && wk.d === label) {
      wk.stale = true;
    }
  }
}

function routeTargets(s: DeliveryState, rcpt: RcptKey): EndpointName[] | null {
  // null: dropped. The most specific enabled route wins; a disabled route falls through.
  const chain: RouteName[] = rcpt === "a" ? ["r1", "r3"] : rcpt === "x" ? ["r2", "r3"] : ["r3"];
  for (const r of chain) {
    const route = s.routes[r];
    if (!route.enabled) continue;
    return route.drop ? null : [...route.to];
  }
  return [];
}

function queueDelivery(s: DeliveryState, label: string, ep: EndpointName, msg: string): void {
  if (!s.routed.some(([m, e]) => m === msg && e === ep)) {
    s.routed.push([msg, ep]);
  }
  if (!findDelivery(s, label)) {
    s.ds.push({
      label,
      ep,
      msg,
      status: "pending",
      count: 0,
      err: null,
      fence: null,
      job: { status: "pending", attempts: 0, expired: false },
      delay: 0,
      tries: 0,
      generation: 0,
      aged: false,
      expiredHold: false,
    });
  }
}

function applyIngest(s: DeliveryState, m: string, rcpts: RcptKey[], variant: MsgVariant): string {
  const email = emailOf(m);
  const prevRcpts = s.receipts[m];
  // A duplicate notification (same receipt, no new recipient) changes nothing.
  if (prevRcpts && rcpts.every((r) => prevRcpts.includes(r))) {
    return "ok";
  }
  const all: RcptKey[] = prevRcpts ? [...prevRcpts] : [];
  for (const r of rcpts) {
    if (!all.includes(r)) all.push(r);
  }
  s.receipts[m] = all;
  if (!s.emails[email]) {
    s.emails[email] = { rcpts: [], variant, stored: null, stripped: false };
  }
  // A receipt whose every recipient a route drops is settled without storing anything.
  if (all.every((r) => r !== "b" && routeTargets(s, r) === null)) {
    return "ok";
  }
  const e = s.emails[email]!;
  if (e.stored === null) e.stored = m;
  const stored = e.stored;
  // Recipients the stored email was already routed for are not routed again, whichever
  // receipt (a duplicate notification, a reopen, another SES ID) brings them.
  const fresh = all.filter((r) => !e.rcpts.includes(r));
  e.rcpts.push(...fresh);
  for (const r of fresh) {
    if (r === "b") {
      const labels =
        s.ritual === "max" ? ["l"] : s.ritual === "over" ? ["ritual-error", "spam"] : [];
      const freshBox = !(stored in s.boxed);
      if (freshBox) s.boxed[stored] = labels;
      // A paused endpoint holds new mail: it is queued like any other, then parked.
      for (const [ep, idx] of ritualCalls(s.ritual)) {
        if (s.eps[ep]) {
          const label = `${stored}:${ep}${ep === "S" && idx > 0 ? idx : ""}`;
          queueDelivery(s, label, ep, stored);
        }
      }
      // U subscribes to box@'s message.received events (not junk: it skips junk).
      if (freshBox && s.ritual !== "over" && s.eps.U) {
        queueDelivery(s, `${stored}:U`, "U", stored);
      }
    } else {
      const targets = routeTargets(s, r);
      if (targets) {
        for (const ep of targets) {
          if (s.eps[ep]) {
            queueDelivery(s, `${stored}:${ep}`, ep, stored);
          }
        }
      }
    }
  }
  return "ok";
}

function settleDelivery(
  s: DeliveryState,
  label: string,
  attempts: number,
  stale: boolean,
  job: [string, number | "d" | null] | null,
  record: [string, string | null] | null,
): void {
  const d = findDelivery(s, label);
  if (!d) return;
  const current = !stale && d.job !== null && d.job.status === "running" && d.job.attempts === attempts;
  if (!current) return;
  if (job) {
    const [status, delay] = job;
    d.job!.status = status;
    if (status === "pending") {
      // A deferral returns the claim's attempt; a retry keeps it.
      if (delay === "d") {
        d.job!.attempts -= 1;
      }
      d.delay = delay;
    }
  }
  if (record) {
    const [status, err] = record;
    if (d.status === "pending") {
      d.count += 1;
      d.status = status;
      d.err = err;
    }
  }
}

function handleClaim(
  s: DeliveryState,
  w: WorkerName,
  label: string,
  attempts: number,
  stale: boolean,
  hook: boolean,
  generation: number,
): unknown {
  const d = findDelivery(s, label);
  if (!d) return "done";
  if (!hook) {
    settleDelivery(s, label, attempts, stale, ["completed", null], null);
    return "done";
  }
  const ep = d.ep;
  const e = s.eps[ep];
  if (!e) return "done";
  // The fence attempts only a delivery still pending at the claimed generation, for a runner
  // whose job lease is still its own.
  if (stale || d.status !== "pending" || d.generation !== generation) {
    settleDelivery(s, label, attempts, stale, ["completed", null], null);
    return "done";
  }
  if (e.paused) {
    // Decided after the pause committed: park like the claim does.
    if (d.status === "pending") {
      d.status = "paused";
      d.err = "ENDPOINT_PAUSED";
    }
    settleDelivery(s, label, attempts, stale, ["completed", null], null);
    return "done";
  }
  if (isPlainSub(ep)) {
    if (e.timeouts >= 3) {
      settleDelivery(s, label, attempts, stale, ["pending", "d"], null);
      return "done";
    }
    d.tries += 1;
    s.workers[w] = { kind: "flight", d: label, attempts, stale, ep, generation };
    return { sending: ep, d: label };
  }
  if (d.fence === "delivered") {
    settleDelivery(s, label, attempts, stale, ["completed", null], ["delivered", null]);
    return "done";
  }
  if ((d.fence === "unknown" || d.fence === "sending") && !isReplaySafe(ep)) {
    settleDelivery(s, label, attempts, stale, ["failed", null], ["failed", "ACTION_UNKNOWN"]);
    return "done";
  }
  if (e.used >= e.perMinute) {
    settleDelivery(s, label, attempts, stale, ["pending", "d"], null);
    return "done";
  }
  e.used += 1;
  d.fence = "sending";
  d.tries += 1;
  if (ep === "F") {
    const msg = s.emails[emailOf(d.msg)]!;
    const variant = msg.variant;
    const blocked = variant === "loop" || variant === "recv25" || msg.stripped;
    let status: string;
    let err: string | null;
    if (e.declined) {
      status = "failed";
      err = "CONNECTOR_UNAVAILABLE";
    } else if (blocked) {
      status = "failed";
      err = "FORWARD_BLOCKED";
    } else {
      if (!s.forwards.includes(d.msg)) {
        s.forwards.push(d.msg);
        s.forwards.sort();
        s.forwardSends += 1;
      }
      status = "delivered";
      err = null;
    }
    d.fence = status === "delivered" ? "delivered" : "retry";
    settleDelivery(
      s,
      label,
      attempts,
      stale,
      [status === "delivered" ? "completed" : "failed", null],
      [status, err],
    );
    return "done";
  }
  if (e.timeouts >= 3) {
    // The transport breaker defers the call; nothing was sent, so it is not an attempt.
    d.fence = "retry";
    d.tries -= 1;
    settleDelivery(s, label, attempts, stale, ["pending", "d"], null);
    return "done";
  }
  s.workers[w] = { kind: "flight", d: label, attempts, stale, ep, generation };
  return { sending: ep, d: label };
}

function applyRun(s: DeliveryState, w: WorkerName, label: string, gate: boolean): unknown {
  const d = findDelivery(s, label)!;
  const max = maxAttemptsFor(d.ep, s.retries);
  const job = d.job!;
  // The last attempt's lease expired: dead-letter it. For a fenced delivery, a claim that never
  // reached the fence (nothing was sent) does not use up the last attempt; one more is allowed.
  const fencedShort = !isPlainSub(d.ep) && d.tries < job.attempts;
  if (job.status === "running" && job.attempts >= max && (job.attempts > max || !fencedShort)) {
    job.status = "failed";
    if (d.status === "pending") {
      d.status = "failed";
      d.err = "JOB_LEASE_EXHAUSTED";
    }
    return "done";
  }
  job.status = "running";
  job.attempts += 1;
  job.expired = false;
  const attempts = job.attempts;
  const generation = d.generation;
  // The claim joins the endpoint: a paused one parks the delivery, a settled one is skipped.
  let hook: boolean;
  if (d.status !== "pending") {
    hook = false;
  } else if (s.eps[d.ep]!.paused) {
    d.status = "paused";
    d.err = "ENDPOINT_PAUSED";
    hook = false;
  } else {
    hook = true;
  }
  if (gate) {
    s.workers[w] = { kind: "parked", d: label, attempts, stale: false, hook, generation };
    return "claimed";
  }
  return handleClaim(s, w, label, attempts, false, hook, generation);
}

function applyReply(s: DeliveryState, w: WorkerName, resp: string, sends: SendTuple[]): string {
  const wk = s.workers[w];
  if (wk.kind !== "flight") throw new Error(`reply on non-flight worker ${w}`);
  const { d: label, attempts, stale, ep } = wk;
  s.workers[w] = { kind: "idle" };
  sends.push([ep, label, isKeyed(ep)]);
  const [kind = "", arg] = resp.split(" ");
  const e = s.eps[ep];
  if (e) {
    if (kind === "timeout") e.timeouts += 1;
    else if (kind !== "reset") e.timeouts = 0;
  }
  const max = maxAttemptsFor(ep, s.retries);
  const setFence = (f: string) => {
    const d = findDelivery(s, label);
    if (d) d.fence = f;
  };
  const retry = (code: string, afterMs: number) => {
    if (attempts < max) {
      settleDelivery(s, label, attempts, stale, ["pending", backoffSeconds(attempts, afterMs)], ["pending", code]);
    } else {
      settleDelivery(s, label, attempts, stale, ["failed", null], ["failed", code]);
    }
  };
  if (isPlainSub(ep)) {
    // Event-subscription semantics: no attempt row; every HTTP error but 410 and every
    // transport error is retried, with plain backoff (Retry-After is not read).
    const status = /^\d+$/.test(kind) ? Number(kind) : 0;
    if (status >= 200 && status < 300) {
      settleDelivery(s, label, attempts, stale, ["completed", null], ["delivered", null]);
    } else {
      const code = status === 0 ? "WEBHOOK_NETWORK_ERROR" : "WEBHOOK_HTTP_ERROR";
      if (status !== 410) {
        retry(code, 0);
      } else {
        settleDelivery(s, label, attempts, stale, ["failed", null], ["failed", code]);
      }
    }
    return "done";
  }
  if (kind === "timeout" || kind === "reset") {
    setFence("unknown");
    if (isReplaySafe(ep)) {
      retry("ACTION_UNKNOWN", 0);
    } else {
      settleDelivery(s, label, attempts, stale, ["failed", null], ["failed", "ACTION_UNKNOWN"]);
    }
  } else {
    const status = /^\d+$/.test(kind) ? Number(kind) : 0;
    if (status >= 200 && status < 300) {
      setFence("delivered");
      settleDelivery(s, label, attempts, stale, ["completed", null], ["delivered", null]);
    } else if (status === 429 || status === 408 || status >= 500) {
      setFence("retry");
      retry(status === 429 ? "DESTINATION_THROTTLED" : "DESTINATION_UNAVAILABLE", retryAfterMs(arg));
    } else {
      setFence("retry");
      settleDelivery(s, label, attempts, stale, ["failed", null], ["failed", "DESTINATION_REFUSED"]);
    }
  }
  return "done";
}

function applyOne(s: DeliveryState, a: Exclude<DeliveryAction, { op: "Configure" } | { op: "Drain" }>, sends: SendTuple[]): unknown {
  switch (a.op) {
    case "Ingest":
      return applyIngest(s, a.m, a.rcpts, a.variant);
    case "Run":
      return applyRun(s, a.w, a.d, a.gate);
    case "Go": {
      const wk = s.workers[a.w];
      if (wk.kind !== "parked") throw new Error(`go on non-parked worker ${a.w}`);
      s.workers[a.w] = { kind: "idle" };
      return handleClaim(s, a.w, wk.d, wk.attempts, wk.stale, wk.hook, wk.generation);
    }
    case "Reply":
      return applyReply(s, a.w, a.resp, sends);
    case "Crash": {
      const wk = s.workers[a.w];
      if (wk.kind === "flight" && a.sent) {
        sends.push([wk.ep, wk.d, isKeyed(wk.ep)]);
      }
      s.workers[a.w] = { kind: "idle" };
      return "ok";
    }
    case "Expire": {
      const d = findDelivery(s, a.d);
      if (d?.job) d.job.expired = true;
      markStale(s, a.d);
      return "ok";
    }
    case "Tick":
      for (const ep of Object.values(s.eps)) {
        if (ep) ep.used = 0;
      }
      return "ok";
    case "Pause": {
      const ep = s.eps[a.e]!;
      ep.paused = a.on;
      if (!a.on) {
        // Resume: every parked delivery of the endpoint still within retention gets a new
        // generation and job. Older ones stay parked until the sweep dead-letters them.
        const parked = s.ds.filter((d) => d.ep === a.e && d.status === "paused" && !d.aged).map((d) => d.label);
        for (const label of parked) {
          markStale(s, label);
          const d = findDelivery(s, label)!;
          d.status = "pending";
          d.err = null;
          // The attempts already made still count: a pause holds retries, it does not refill them.
          d.job = { status: "pending", attempts: Math.max(d.count, d.tries), expired: false };
          d.generation += 1;
          d.delay = 0;
        }
      }
      return "ok";
    }
    case "Delete": {
      delete s.eps[a.e];
      s.ds = s.ds.filter((d) => d.ep !== a.e);
      for (const r of Object.values(s.routes)) {
        r.to = r.to.filter((x) => x !== a.e);
      }
      if (a.e === "S" || a.e === "F") {
        s.ritual = "none";
      }
      return "ok";
    }
    case "Rituals": {
      // A ritual may call a forward only once its recipient allowed it.
      if (ritualCalls(a.mode).some(([ep]) => ep === "F") && s.eps.F?.declined) {
        return "e:UNKNOWN_ENDPOINT";
      }
      s.ritual = a.mode;
      return "ok";
    }
    case "RouteSet": {
      const route = s.routes[a.r];
      if (a.state === "on") route.enabled = true;
      else if (a.state === "off") route.enabled = false;
      else route.drop = true;
      return "ok";
    }
    case "Rate":
      s.eps[a.e]!.perMinute = a.n;
      return "ok";
    case "Decline":
      s.eps.F!.declined = true;
      return "ok";
    case "Age":
      findDelivery(s, a.d)!.aged = true;
      return "ok";
    case "Prune": {
      // Past retention: settled deliveries are deleted; a delivery still held for a paused
      // endpoint is dead-lettered with a reason (and kept a while to be seen) instead.
      for (const d of s.ds) {
        if (d.aged && d.status === "paused") {
          d.status = "failed";
          d.err = "ENDPOINT_PAUSED_EXPIRED";
          d.expiredHold = true;
        }
      }
      for (const d of s.ds) {
        if (d.aged && !d.expiredHold && (d.status === "delivered" || d.status === "failed")) {
          s.pruned.push([d.msg, d.ep]);
        }
      }
      s.ds = s.ds.filter(
        (d) => !(d.aged && !d.expiredHold && (d.status === "delivered" || d.status === "failed")),
      );
      return "ok";
    }
    case "Strip": {
      const msg = s.emails[emailOf(a.m)];
      if (msg) msg.stripped = true;
      return "ok";
    }
  }
}

const DRAIN_EP_ORDER: EndpointName[] = ["F", "S", "U", "V", "W"];

function applyDrain(s: DeliveryState, sends: SendTuple[]): string {
  for (let i = 0; i < 200; i++) {
    let acted = false;
    for (const w of WORKERS) {
      if (s.workers[w].kind === "flight") {
        applyOne(s, { op: "Reply", w, resp: "503" }, sends);
        acted = true;
        break;
      }
      if (s.workers[w].kind === "parked") {
        applyOne(s, { op: "Go", w }, sends);
        acted = true;
        break;
      }
    }
    if (acted) continue;

    const pausedEp = DRAIN_EP_ORDER.find((e) => s.eps[e]?.paused);
    if (pausedEp) {
      applyOne(s, { op: "Pause", e: pausedEp, on: false }, sends);
      continue;
    }

    if (Object.values(s.eps).some((e) => e && e.used >= e.perMinute)) {
      applyOne(s, { op: "Tick" }, sends);
      continue;
    }

    const sortedDs = [...s.ds].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    const due = sortedDs.find(
      (d) => d.job !== null && (d.job.status === "pending" || (d.job.status === "running" && d.job.expired)),
    );
    if (due) {
      applyOne(s, { op: "Run", w: "L", d: due.label, gate: false }, sends);
      continue;
    }

    const running = sortedDs.find((d) => d.job !== null && d.job.status === "running" && !d.job.expired);
    if (running) {
      applyOne(s, { op: "Expire", d: running.label }, sends);
      continue;
    }
    break;
  }
  return "drained";
}

function buildView(s: DeliveryState): DeliveryView {
  const b: Record<string, string[]> = {};
  for (const k of Object.keys(s.boxed).sort()) {
    b[k] = [...s.boxed[k]!].sort();
  }
  const d: Record<string, DeliveryRowView> = {};
  for (const row of s.ds) {
    d[row.label] = [
      row.status,
      row.count,
      row.err,
      row.fence,
      row.job ? [row.job.status, row.job.attempts] : null,
      row.delay,
    ];
  }
  const e: Record<string, [boolean, boolean]> = {};
  for (const ep of ENDPOINTS) {
    const rec = s.eps[ep];
    if (rec) e[ep] = [rec.paused, rec.declined];
  }
  return { b, d, e, f: [...s.forwards].sort(), fs: s.forwardSends };
}

function isEnabled(s: DeliveryState, a: DeliveryAction): boolean {
  if (!s.configured) return a.op === "Configure";
  switch (a.op) {
    case "Configure":
      return false;
    case "Ingest": {
      const email = emailOf(a.m);
      if (a.rcpts.some((r) => r !== "a" && r !== "x" && r !== "z" && r !== "b")) return false;
      // A duplicate dN carries mN's content, so only after mN.
      if (a.m.startsWith("d") && !(email in s.emails)) return false;
      const existing = s.emails[email];
      if (existing && a.variant !== existing.variant) return false;
      const old = s.receipts[a.m];
      if (old) return old.every((r) => a.rcpts.includes(r));
      return true;
    }
    case "Run": {
      if (s.workers[a.w].kind !== "idle") return false;
      const d = findDelivery(s, a.d);
      return d?.job != null && (d.job.status === "pending" || (d.job.status === "running" && d.job.expired));
    }
    case "Go":
      return s.workers[a.w].kind === "parked";
    case "Reply":
      return s.workers[a.w].kind === "flight";
    case "Crash": {
      const wk = s.workers[a.w];
      return wk.kind === "flight" ? true : wk.kind === "parked" ? !a.sent : false;
    }
    case "Expire": {
      const d = findDelivery(s, a.d);
      return d?.job != null && d.job.status === "running" && !d.job.expired;
    }
    case "Tick":
      return Object.values(s.eps).some((e) => e && e.used > 0);
    case "Pause": {
      const e = s.eps[a.e];
      return e !== undefined && e.paused !== a.on;
    }
    case "Delete":
      return s.eps[a.e] !== undefined;
    case "Rituals": {
      if (a.mode === s.ritual) return false;
      const needed = [...ritualCalls(a.mode).map(([ep]) => ep), ...(a.mode === "over" ? (["S"] as EndpointName[]) : [])];
      return needed.every((ep) => s.eps[ep] !== undefined);
    }
    case "RouteSet": {
      const r = s.routes[a.r];
      if (a.state === "on") return !r.enabled;
      if (a.state === "off") return r.enabled;
      return !r.drop;
    }
    case "Rate": {
      const e = s.eps[a.e];
      return e !== undefined && e.perMinute !== a.n;
    }
    case "Decline":
      return s.eps.F !== undefined && !s.eps.F.declined;
    case "Age": {
      const d = findDelivery(s, a.d);
      return d !== undefined && !d.aged;
    }
    case "Prune":
      return s.ds.some((d) => d.aged);
    case "Strip":
      return s.emails[a.m]?.stored != null && !s.emails[a.m]?.stripped;
    case "Drain": {
      // Transport breaker waits 30 s of real time; skip drain when tripped.
      if (Object.values(s.eps).some((e) => e && e.timeouts >= 3)) return false;
      const anyActiveWorker = WORKERS.some((w) => s.workers[w].kind !== "idle");
      const anyUnsettled = s.ds.some(
        (d) =>
          (d.status !== "delivered" && d.status !== "failed" && d.status !== "paused") ||
          (d.job !== null && (d.job.status === "pending" || d.job.status === "running")),
      );
      const anyResumablePaused = s.ds.some((d) => d.status === "paused" && !d.aged && s.eps[d.ep]?.paused);
      return anyActiveWorker || anyUnsettled || anyResumablePaused;
    }
  }
}

const MSGS = ["m1", "d1", "m2", "m3"] as const;
const RCPT_COMBOS: RcptKey[][] = [["a"], ["x"], ["z"], ["b"], ["a", "z"], ["b", "z"]];
const RATE_EPS: RateEndpointName[] = ["W", "V", "S", "F"];
const ROUTE_NAMES: RouteName[] = ["r1", "r3"];
const ROUTE_STATES: RouteState[] = ["on", "off", "drop"];

/** Idle rules over raw host snapshots (independent of model step predictions). */
const deliveryIdleRules: IdleRule<DeliverySnapshot>[] = [
  // Temporal/cap rule: delivery.attempts — at most 1 + retryAttempts sends per delivery.
  {
    id: "delivery.attempts",
    description: "an endpoint receives a delivery at most 1 + retryAttempts times",
    when: (s) => s.configured,
    check(s) {
      for (const [label, count] of Object.entries(s.sendCounts)) {
        const ep = epOfDelivery(label);
        const limit = maxAttemptsFor(ep, s.retries);
        if (count > limit) {
          return `delivery ${label} sent ${count} times, exceeding limit ${limit} (retries=${s.retries})`;
        }
      }
      return undefined;
    },
  },
  // No-loss safety invariant: delivery.kept on host DB observations.
  {
    id: "delivery.kept",
    description: "no observed delivery vanishes unless its endpoint was deleted or retention pruned a settled one",
    when: (s) => s.configured,
    check: (s) => (s.lostDeliveries.length ? `lost deliveries: ${s.lostDeliveries.join(", ")}` : undefined),
  },
  // Liveness/drain rule: delivery.settles — after Drain, every delivery is settled or parked/deleted.
  {
    id: "delivery.settles",
    description: "on drained traces, every queued delivery is delivered, dead-lettered, parked or deleted",
    when: (s) => s.configured && s.drainCount > 0,
    optional: true,
    check: (s) =>
      s.unsettledAfterDrain.length ? `unsettled after drain: ${s.unsettledAfterDrain.join(", ")}` : undefined,
  },
  // No duplicate delivery rows for one (message, endpoint, call).
  {
    id: "delivery.no-duplicate-rows",
    description: "no duplicate delivery rows exist for the same (message, endpoint, call)",
    when: (s) => s.configured,
    check: (s) =>
      s.duplicateDeliveries.length ? `duplicate delivery rows: ${s.duplicateDeliveries.join(", ")}` : undefined,
  },
  // Host hygiene: no unhandled rejections or uncaught exceptions.
  {
    id: "delivery.no-leaked-errors",
    description: "no unhandled rejections or uncaught exceptions in the host",
    when: (s) => s.configured,
    check: (s) => (s.leakedErrors.length ? `leaked: ${s.leakedErrors.join("; ")}` : undefined),
  },
];

/** Declarative temporal properties evaluated by tear's monitor over raw host events. */
const deliveryTemporal: TemporalProperty[] = [
  {
    id: "delivery.once",
    title:
      "non-replay-safe endpoints receive each delivery at most once (no repeat after success/unknown or overlap); replay-safe V always carries its own Idempotency-Key",
    prop: prop.all(
      // 0: No delivery.start for a non-replay-safe delivery after success or unknown outcome.
      prop.optional(
        prop.forEach(
          { name: "afterUnsafe", discover: sel.event("delivery.unsafe"), key: "/delivery" },
          (d) => [prop.never(sel.event("delivery.start", { "/delivery": d }))],
        ),
      ),
      // 1: No overlapping delivery.start while another request for the same non-replay-safe delivery is in flight.
      prop.optional(
        prop.forEach(
          { name: "overlap", discover: sel.event("delivery.inflight"), key: "/delivery" },
          (d) => [
            prop.optional(
              prop.whenever(
                sel.event("delivery.start", { "/delivery": d, "/nonReplaySafe": true }),
                check.not(
                  check.since(
                    check.not(check.matches(sel.event("delivery.flight_end", { "/delivery": d }))),
                    sel.event("delivery.inflight", { "/delivery": d }),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
      // 2: Replay-safe webhook V always sends the delivery's own Idempotency-Key.
      prop.optional(
        prop.whenever(
          sel.event("delivery.send", { "/ep": "V" }),
          check.matches(sel.event("delivery.send", { "/keyValid": true })),
        ),
      ),
    ),
  },
  {
    id: "endpoint.held",
    title: "no request starts to an endpoint that was paused or deleted before the step",
    prop: prop.all(
      // 0: No delivery.start while paused (between endpoint.paused and endpoint.unpaused).
      prop.optional(
        prop.forEach(
          { name: "paused", discover: sel.event("endpoint.paused"), key: "/ep" },
          (ep) => [
            prop.optional(
              prop.whenever(
                sel.event("delivery.start", { "/ep": ep }),
                check.not(
                  check.since(
                    check.not(check.matches(sel.event("endpoint.unpaused", { "/ep": ep }))),
                    sel.event("endpoint.paused", { "/ep": ep }),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
      // 1: No delivery.start after endpoint.deleted.
      prop.optional(
        prop.forEach(
          { name: "deleted", discover: sel.event("endpoint.deleted"), key: "/ep" },
          (ep) => [prop.never(sel.event("delivery.start", { "/ep": ep }))],
        ),
      ),
    ),
  },
];

export const delivery = model<DeliveryState, DeliveryAction, DeliveryObs, DeliverySnapshot>({
  id: "delivery",
  description:
    "Nightmail received-mail delivery: routing, rules, endpoints, retries, backoff, rate limits, attempt fences, pause/resume, forward decline/loop, and 30-day retention",
  maxSteps: 28,
  bug: "canary_double_start",

  initial: () => emptyState(),

  choices(s): Choice<DeliveryAction>[] {
    if (!s.configured) {
      return [
        choice({ op: "Configure", preset: "retries1" }, 6),
        choice({ op: "Configure", preset: "retries0" }, 3),
        choice({ op: "Configure", preset: "retries2" }, 2),
        choice({ op: "Configure", preset: "retries9" }, 1),
      ];
    }
    const out: Choice<DeliveryAction>[] = [];
    const push = (a: DeliveryAction, weight: number) => {
      if (isEnabled(s, a)) out.push(choice(a, weight));
    };

    // Ingest: keep total ingest weight balanced against delivery/worker/admin actions.
    const hasWork = s.ds.length > 0;
    for (const m of MSGS) {
      const baseW = m === "m1" || m === "d1" ? 2 : 1;
      for (const rcpts of RCPT_COMBOS) {
        for (const variant of MSG_VARIANTS) {
          const w = hasWork ? 1 : variant === "plain" ? baseW * 2 : baseW;
          push({ op: "Ingest", m, rcpts, variant }, w);
        }
      }
    }

    // Worker actions on existing deliveries.
    for (const w of WORKERS) {
      for (const d of s.ds) {
        push({ op: "Run", w, d: d.label, gate: false }, 36);
        push({ op: "Run", w, d: d.label, gate: true }, 18);
      }
      push({ op: "Go", w }, 45);
      for (const resp of RESPONSES) {
        push({ op: "Reply", w, resp }, 12);
      }
      push({ op: "Crash", w, sent: true }, 12);
      push({ op: "Crash", w, sent: false }, 12);
    }

    for (const d of s.ds) {
      push({ op: "Expire", d: d.label }, 22);
      push({ op: "Age", d: d.label }, 10);
    }

    push({ op: "Tick" }, 20);
    push({ op: "Prune" }, 16);
    push({ op: "Decline" }, 8);

    for (const e of ENDPOINTS) {
      push({ op: "Pause", e, on: true }, 14);
      push({ op: "Pause", e, on: false }, 16);
      push({ op: "Delete", e }, 2);
    }
    for (const e of RATE_EPS) {
      push({ op: "Rate", e, n: 1 }, 8);
      push({ op: "Rate", e, n: 60 }, 6);
    }
    for (const mode of RITUAL_MODES) {
      push({ op: "Rituals", mode }, 12);
    }
    for (const r of ROUTE_NAMES) {
      for (const state of ROUTE_STATES) {
        push({ op: "RouteSet", r, state }, 5);
      }
    }
    for (const m of ["m1", "m2", "m3"]) {
      push({ op: "Strip", m }, 8);
    }
    push({ op: "Drain" }, 10);

    return out;
  },

  step(s, a): Step<DeliveryState, DeliveryObs> {
    if (a.op === "Configure") {
      const next = initialForPreset(a.preset);
      return {
        next,
        expect: exact({ r: "ok", sends: [], view: buildView(next) }),
      };
    }

    // Known product bug DLV-1: mailbox.resumeDeliveries computes resumed attempts as
    // greatest(r.attempt_count, coalesce(a.attempts, 0)), but plain event subscriptions (U) have
    // no mail_action_attempts row. Unpausing a parked U delivery with an unrecorded send (crash or
    // expired-lease reply) resets jobs.attempts to attempt_count, refilling its retry budget and
    // letting it exceed 1 + retryAttempts sends.
    const hitsDlv1 =
      ((a.op === "Pause" && !a.on && a.e === "U") || (a.op === "Drain" && s.eps.U?.paused === true)) &&
      s.ds.some((d) => d.ep === "U" && d.status === "paused" && !d.aged && d.tries > d.count);

    const next = cloneState(s);
    const sends: SendTuple[] = [];
    const r = a.op === "Drain" ? applyDrain(next, sends) : applyOne(next, a, sends);
    return {
      next,
      expect: exact({ r, sends, view: buildView(next) }),
      ...(hitsDlv1 ? { mask: "DLV-1" } : {}),
    };
  },

  /** Model property delivery.kept: every (email, endpoint) routing or a ritual queued keeps its delivery unless deleted or pruned. */
  check(s): string[] {
    if (!s.configured) return [];
    const violations: string[] = [];
    for (const [m, e] of s.routed) {
      const epExists = s.eps[e as EndpointName] !== undefined;
      const hasDelivery = s.ds.some((d) => d.msg === m && d.ep === e);
      const wasPruned = s.pruned.some(([pm, pe]) => pm === m && pe === e);
      if (epExists && !hasDelivery && !wasPruned) {
        violations.push(`delivery.kept: ${m}:${e} was routed but has no delivery`);
      }
    }
    return violations;
  },

  idle: deliveryIdleRules,
  temporal: deliveryTemporal,
});
