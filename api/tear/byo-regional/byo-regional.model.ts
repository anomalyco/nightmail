import { anyReply, choice, model, type Choice, type IdleRule, type Step } from "@tear/mbt";
import type { ByoAction, ByoObs, ByoPreset, ByoRegion, ByoSnapshot } from "./byo-regional.types.ts";

export interface ByoState {
  configured: boolean;
  preset: ByoPreset | null;
  connected: boolean;
  disconnecting: boolean;
  paused: boolean;
  hasIntent: Record<ByoRegion, boolean>;
}

const byoIdleRules: IdleRule<ByoSnapshot>[] = [
  // Invariant 1: No orphan open intent or stuck provisioning region without an active backing job
  {
    id: "byo.no-orphan-pending-intent",
    description:
      "no open byo_domain_intents row or provisioning region may exist without an active pending/running backing job",
    when: (s) => s.configured && s.connectionExists && s.connectionState !== "disconnecting",
    check(s) {
      for (const i of s.intents) {
        if (i.closedReason !== null) continue;
        const jobStatus = i.regionSendingState === "ready" ? i.bindJobStatus : i.provisionJobStatus;
        if (jobStatus !== "pending" && jobStatus !== "running") {
          return `orphan open intent ${i.id} (${i.name} in ${i.region}): region=${i.regionSendingState}, backing job=${jobStatus ?? "missing"}`;
        }
      }
      for (const r of s.regions) {
        if (r.sendingState === "provisioning" && r.provisionJobStatus !== "pending" && r.provisionJobStatus !== "running") {
          return `stuck provisioning region ${r.region}: byo.provision job=${r.provisionJobStatus ?? "missing"}`;
        }
      }
      return undefined;
    },
  },

  // Invariant 2: A paused v5 connection is never deleted by DELETE /v1/connection or mid-flight byo.disconnect
  {
    id: "byo.paused-never-deleted",
    description: "a paused BYO v5 connection cannot be deleted via DELETE /v1/connection or byo.disconnect",
    when: (s) => s.configured,
    check(s) {
      if (s.pausedDeleteViolations.length > 0) {
        return `paused delete bypass: ${s.pausedDeleteViolations.join("; ")}`;
      }
      if (s.wasPausedBeforeLastDelete && !s.connectionExists) {
        return "paused v5 connection row disappeared during disconnect";
      }
      return undefined;
    },
  },

  // Invariant 3: All mutations while disconnecting refuse cleanly with 409 (never 201/202/502)
  {
    id: "byo.disconnecting-never-201-or-502",
    description: "all mutations while state='disconnecting' refuse cleanly with 409 CONNECTION_DISCONNECTING",
    when: (s) => s.configured,
    check(s) {
      if (s.disconnectingMutationViolations.length > 0) {
        return `disconnecting mutation accepted/5xx: ${s.disconnectingMutationViolations.join("; ")}`;
      }
      return undefined;
    },
  },

  // Invariant 4: Exhausted region/bind retries are cleanly recoverable in another region or on retry
  {
    id: "byo.exhausted-region-recoverable",
    description: "after region or bind retries exhaust, adding the domain in a healthy region or retrying the region succeeds without 409 DOMAIN_REGION_CONFLICT",
    when: (s) => s.configured,
    check(s) {
      if (s.exhaustedRecoveryViolations.length > 0) {
        return `exhausted recovery failed: ${s.exhaustedRecoveryViolations.join("; ")}`;
      }
      return undefined;
    },
  },

  // Host hygiene
  {
    id: "byo.no-leaked-errors",
    description: "no unhandled rejections or uncaught exceptions in the byo-regional host",
    when: (s) => s.configured,
    check: (s) => (s.leakedErrors.length ? `leaked: ${s.leakedErrors.join("; ")}` : undefined),
  },
];

export const byoRegional = model<ByoState, ByoAction, ByoObs, ByoSnapshot>({
  id: "byo-regional",
  description: "Nightmail BYO v5 regional provisioning, binding, operator pause fence, and disconnect cleanup",
  maxSteps: 18,
  bug: "canary_orphan_intent",

  initial: () => ({
    configured: false,
    preset: null,
    connected: false,
    disconnecting: false,
    paused: false,
    hasIntent: { "us-east-2": false, "us-east-1": false },
  }),

  choices(s): Choice<ByoAction>[] {
    if (!s.configured) {
      return [
        choice({ op: "Configure", preset: "readyToImport" }, 4),
        choice({ op: "Configure", preset: "fresh" }, 1),
        choice({ op: "Configure", preset: "hosted" }, 2),
      ];
    }

    if (s.preset === "hosted") {
      return [
        choice({ op: "OperatorPause" }, 3),
        choice({ op: "OperatorResume" }, 3),
        choice({ op: "SetDisconnectFault", fault: "ok" }, 2),
        choice({ op: "SetDisconnectFault", fault: "pause_mid_disconnect" }, 3),
        choice({ op: "Disconnect" }, 4),
        choice({ op: "Verify" }, 2),
      ];
    }

    const out: Choice<ByoAction>[] = [
      choice({ op: "SetRegionFault", region: "us-east-2", fault: "ok" }, 2),
      choice({ op: "SetRegionFault", region: "us-east-2", fault: "wait_sns_confirm" }, 1),
      choice({ op: "SetRegionFault", region: "us-east-2", fault: "retryable_5xx" }, 2),
      choice({ op: "SetRegionFault", region: "us-east-2", fault: "access_denied" }, 2),
      choice({ op: "SetRegionFault", region: "us-east-1", fault: "ok" }, 2),
      choice({ op: "SetRegionFault", region: "us-east-1", fault: "wait_sns_confirm" }, 1),
      choice({ op: "SetRegionFault", region: "us-east-1", fault: "retryable_5xx" }, 2),
      choice({ op: "SetRegionFault", region: "us-east-1", fault: "access_denied" }, 1),
      choice({ op: "SetDisconnectFault", fault: "ok" }, 2),
      choice({ op: "SetDisconnectFault", fault: "retryable_5xx" }, 1),
      choice({ op: "SetDisconnectFault", fault: "access_denied" }, 1),
      choice({ op: "Verify" }, 1),
    ];

    if (!s.connected) {
      out.push(choice({ op: "Connect" }, 6));
      return out;
    }

    out.push(
      choice({ op: "SelectImports", region: "us-east-2", domain: "alpha" }, 3),
      choice({ op: "SelectImports", region: "us-east-2", domain: "beta" }, 2),
      choice({ op: "SelectImports", region: "us-east-1", domain: "alpha" }, 2),
      choice({ op: "SelectImports", region: "us-east-1", domain: "beta" }, 2),
      choice({ op: "NewRegionalDomain", region: "us-east-2", domain: "alpha" }, 2),
      choice({ op: "NewRegionalDomain", region: "us-east-2", domain: "gamma" }, 2),
      choice({ op: "NewRegionalDomain", region: "us-east-1", domain: "alpha" }, 2),
      choice({ op: "NewRegionalDomain", region: "us-east-1", domain: "gamma" }, 2),
      choice({ op: "ProvisionStep", region: "us-east-2" }, 3),
      choice({ op: "ProvisionStep", region: "us-east-2", runToExhaustion: true }, 2),
      choice({ op: "ProvisionStep", region: "us-east-1" }, 3),
      choice({ op: "ProvisionStep", region: "us-east-1", runToExhaustion: true }, 2),
      choice({ op: "ConfirmTopic", region: "us-east-2" }, 2),
      choice({ op: "ConfirmTopic", region: "us-east-1" }, 2),
      choice({ op: "BindStep", region: "us-east-2" }, 3),
      choice({ op: "BindStep", region: "us-east-2", runToExhaustion: true }, 2),
      choice({ op: "BindStep", region: "us-east-1" }, 3),
      choice({ op: "BindStep", region: "us-east-1", runToExhaustion: true }, 2),
      choice({ op: "Disconnect" }, 2),
      choice({ op: "DisconnectStep" }, 3),
    );

    return out;
  },

  step(s, a): Step<ByoState, ByoObs> {
    if (a.op === "Configure") {
      return {
        next: {
          configured: true,
          preset: a.preset,
          connected: a.preset !== "fresh",
          disconnecting: false,
          paused: false,
          hasIntent: { "us-east-2": false, "us-east-1": false },
        },
        expect: anyReply(),
      };
    }

    const next: ByoState = {
      ...s,
      hasIntent: { ...s.hasIntent },
    };

    switch (a.op) {
      case "Connect":
        next.connected = true;
        next.disconnecting = false;
        break;
      case "SelectImports":
      case "NewRegionalDomain":
        if (!next.disconnecting) next.hasIntent[a.region] = true;
        break;
      case "OperatorPause":
        next.paused = true;
        break;
      case "OperatorResume":
        next.paused = false;
        break;
      case "Disconnect":
        if (!next.paused) next.disconnecting = true;
        break;
      default:
        break;
    }

    return { next, expect: anyReply() };
  },

  idle: byoIdleRules,
});
