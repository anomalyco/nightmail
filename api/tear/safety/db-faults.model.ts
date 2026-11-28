/**
 * Preventative property (c): Database fault resilience (incident-2026-11-23 / PR #582 / PR #593 class).
 * Invariant: When the database rejects writes (read-only), stalls (statement/lock timeout or mid-request
 * failure after the first write), or exhausts connections, every API answer is either a success or marked
 * retryable (retryable === true), one Idempotency-Key never creates or sends more than one email, and once
 * the database recovers, every accepted email is delivered once and none is lost.
 */
import { choice, exact, model, prop, satisfies, sel, type Choice, type IdleRule, type Step } from "@tear/mbt";
import type { DbFaultAction, DbFaultObs, DbFaultSnapshot, FaultMode, SendKey } from "./db-faults.types.ts";

export interface DbFaultState {
  fault: FaultMode;
  keysAccepted: SendKey[];
  uncertainKeys: SendKey[];
}

const FAULT_MODES: readonly FaultMode[] = [
  "none",
  "readonly_pg_readonly",
  "readonly_25006",
  "stall_57014",
  "lock_55P03",
  "pool_exhausted_53300",
  "after_first_write_57014",
  "after_second_write_57014",
] as const;

/** Faults that may fail a request after some of its writes committed, so its key's outcome is unknown. */
const midRequest = (mode: FaultMode) => mode === "after_first_write_57014" || mode === "after_second_write_57014";

const dbFaultIdleRules: IdleRule<DbFaultSnapshot>[] = [
  {
    id: "dbfault.no-double-send",
    description: "no accepted email id is ever sent to SES more than once across database faults and retries",
    check: (s) => (s.doubleSentIds.length ? `double-sent ids: ${s.doubleSentIds.join(", ")}` : undefined),
  },
  {
    id: "dbfault.one-id-per-key",
    description: "one Idempotency-Key never produces more than one distinct email id",
    check: (s) => (s.duplicateKeyIds.length ? `multiple email ids for one key: ${s.duplicateKeyIds.join(", ")}` : undefined),
  },
  {
    id: "dbfault.one-send-per-key",
    description: "one Idempotency-Key never causes more than one SES send",
    check: (s) => (s.doubleSentKeys.length ? `multiple SES sends for one key: ${s.doubleSentKeys.join(", ")}` : undefined),
  },
  {
    id: "dbfault.no-lost-email",
    description: "after draining with a healthy database, every accepted email has been delivered to SES",
    check: (s) => (s.lostAfterDrain.length ? `lost after drain: ${s.lostAfterDrain.join(", ")}` : undefined),
  },
  {
    id: "dbfault.no-nonretryable-fault-error",
    description: "under an active DB fault, no API or drain call returns a non-retryable error",
    check: (s) => (s.nonRetryableFaultErrors.length ? `non-retryable fault errors: ${s.nonRetryableFaultErrors.join("; ")}` : undefined),
  },
  {
    id: "dbfault.no-leaked-errors",
    description: "no unhandled rejections or host errors",
    check: (s) => (s.leakedErrors.length ? s.leakedErrors.join("; ") : undefined),
  },
];

export const dbFaults = model<DbFaultState, DbFaultAction, DbFaultObs, DbFaultSnapshot>({
  id: "db-faults",
  description: "Database faults (read-only, timeout stall, mid-request fault, pool exhaustion): retryable answers, at-most-once per key, no lost mail",
  maxSteps: 16,
  bug: "canary_double_send",

  initial: (): DbFaultState => ({ fault: "none", keysAccepted: [], uncertainKeys: [] }),

  choices(s): Choice<DbFaultAction>[] {
    const out: Choice<DbFaultAction>[] = [];
    for (const mode of FAULT_MODES) {
      if (mode !== s.fault) {
        out.push(choice({ op: "SetFault", mode }, mode === "none" ? 4 : 1));
      }
    }
    out.push(
      choice({ op: "Send", key: "k1" }, 3),
      choice({ op: "Send", key: "k2" }, 3),
      choice({ op: "SendSuppressed" }, 2),
      choice({ op: "CreateList" }, 2),
      choice({ op: "ReadMe" }, 2),
      choice({ op: "Drain" }, 3),
    );
    return out;
  },

  step(s, a): Step<DbFaultState, DbFaultObs> {
    const next = structuredClone(s);
    if (a.op === "SetFault") {
      next.fault = a.mode;
      return {
        next,
        expect: exact({ status: 200, code: null, retryable: null, emailId: null, duplicateKeyId: false, drained: false }),
      };
    }

    if (a.op === "Drain") {
      return {
        next,
        expect: satisfies("drain-safe", (obs) => {
          if (s.fault === "none") {
            if (!obs.drained) {
              return `drain failed while DB was healthy: status=${obs.status} code=${obs.code}`;
            }
            return true;
          }
          if (obs.drained || obs.retryable === true) return true;
          return `drain under DB fault ${s.fault} returned non-retryable error: status=${obs.status} code=${obs.code}`;
        }),
      };
    }

    if (a.op === "SendSuppressed") {
      // Its recipient is suppressed, so no attempt queues mail or keeps its Idempotency-Key (s1): a crash after the
      // admission statement must not leave a receipt that a retry replays as a 202 for mail that was never queued.
      return {
        next,
        expect: satisfies("ineligible-never-accepted", (obs) => {
          if (obs.status >= 200 && obs.status < 300) return `a send to a suppressed recipient was accepted (${obs.status}, emailId ${obs.emailId}) under fault ${s.fault}`;
          if (obs.status === 422 && obs.code === "RECIPIENT_INELIGIBLE") return true;
          if (s.fault !== "none" && (obs.status === 503 || obs.status === 409) && obs.retryable === true) return true;
          return `expected 422 RECIPIENT_INELIGIBLE${s.fault === "none" ? "" : " or a retryable 503/409"} under fault ${s.fault}, got ${obs.status} ${obs.code} (retryable=${obs.retryable})`;
        }),
      };
    }

    if (a.op === "Send") {
      if (s.fault === "none" && !next.keysAccepted.includes(a.key)) {
        next.keysAccepted.push(a.key);
      }
      if (midRequest(s.fault) && !next.uncertainKeys.includes(a.key)) {
        next.uncertainKeys.push(a.key);
      }
    }
    const keyUncertain = a.op === "Send" && next.uncertainKeys.includes(a.key);

    const expect = satisfies("success-or-retryable", (obs) => {
      if (obs.duplicateKeyId) {
        return `Idempotency-Key ${a.op === "Send" ? a.key : ""} created a second distinct emailId (${obs.emailId})`;
      }
      if (s.fault === "none") {
        if (obs.status >= 200 && obs.status < 300) return true;
        // Only keys previously sent under a mid-request fault may legitimately return 409 IDEMPOTENCY_OUTCOME_UNKNOWN.
        if (keyUncertain && obs.status === 409 && obs.code === "IDEMPOTENCY_OUTCOME_UNKNOWN") return true;
        return `expected 2xx while DB is healthy, got ${obs.status} ${obs.code} (retryable=${obs.retryable})`;
      }
      if (obs.status >= 200 && obs.status < 300) return true;
      if ((obs.status === 503 || obs.status === 409) && obs.retryable === true) return true;
      if (keyUncertain && obs.status === 409 && obs.code === "IDEMPOTENCY_OUTCOME_UNKNOWN") return true;
      return `under DB fault ${s.fault}, expected 2xx or retryable 503/409, got status=${obs.status} code=${obs.code} retryable=${obs.retryable}`;
    });

    return { next, expect };
  },

  idle: dbFaultIdleRules,

  temporal: [
    {
      id: "dbfault.once",
      title: "an accepted email id is never sent to SES more than once",
      prop: prop.optional(
        prop.forEach(
          { name: "email", discover: sel.event("ses.committed"), key: "/emailId" },
          (emailId) => [prop.never(sel.event("ses.call", { "/emailId": emailId }))],
        ),
      ),
    },
    {
      id: "dbfault.once-per-key",
      title: "one Idempotency-Key is never sent to SES more than once",
      prop: prop.optional(
        prop.forEach(
          { name: "key", discover: sel.event("ses.committed"), key: "/sendKey" },
          (sendKey) => [prop.never(sel.event("ses.call", { "/sendKey": sendKey }))],
        ),
      ),
    },
  ],
});
