import { anyReply, choice, model, type Choice, type IdleRule, type Step } from "@tear/mbt";
import {
  BILLING_PRESETS,
  type BillingAction,
  type BillingObs,
  type BillingPreset,
  type BillingSnapshot,
} from "./billing.types.ts";

export interface BillingState {
  configured: boolean;
  preset: BillingPreset | null;
  attempts: number;
  openDisputes: number;
  totalDisputes: number;
  hasCard: boolean;
  rechargeEnabled: boolean;
  t: number;
}

const FAIL_RECHARGE_CODES = new Set([
  "amount_mismatch",
  "card_declined",
  "insufficient_funds",
  "authentication_required",
  "card_blocked",
  "payment_failed",
]);

const billingIdleRules: IdleRule<BillingSnapshot>[] = [
  // Invariant 1: Zero-sum ledger & credit-lot exactness
  {
    id: "billing.zero-sum-ledger",
    description:
      "ledger sum equals balance_uc, balance_after_uc is exact at every step, active lots equal max(balance_uc, 0), and balance/owed are never both positive",
    when: (s) => s.configured,
    check(s) {
      const balance = BigInt(s.balanceUc);
      const promo = BigInt(s.promoUc);
      const lots = BigInt(s.activeLotsRemainingUc);
      if (promo < 0n) return `promo_uc below zero: ${promo}`;

      let runPaid = 0n;
      let runPromo = 0n;
      let prevId = 0n;
      for (const row of s.ledger) {
        const id = BigInt(row.id);
        if (id <= prevId) return `ledger id non-monotonic: ${id} <= ${prevId}`;
        prevId = id;
        runPaid += BigInt(row.paidUc);
        runPromo += BigInt(row.promoUc);
        if (runPaid !== BigInt(row.balanceAfterUc)) {
          return `ledger row ${row.id} (${row.kind}): running paid ${runPaid} != balance_after_uc ${row.balanceAfterUc}`;
        }
        if (runPromo !== BigInt(row.promoAfterUc)) {
          return `ledger row ${row.id} (${row.kind}): running promo ${runPromo} != promo_after_uc ${row.promoAfterUc}`;
        }
      }
      if (runPaid !== balance) {
        return `ledger paid sum ${runPaid} != billing_accounts.balance_uc ${balance}`;
      }
      if (runPromo !== promo) {
        return `ledger promo sum ${runPromo} != billing_accounts.promo_uc ${promo}`;
      }
      const credit = balance > 0n ? balance : 0n;
      const owed = balance < 0n ? -balance : 0n;
      if (credit > 0n && owed > 0n) {
        return `credit (${credit}) and owed (${owed}) both positive`;
      }
      if (lots !== credit) {
        return `active credit lots sum ${lots} != max(balance_uc, 0) ${credit} (balance=${balance})`;
      }
      if (owed > 0n && lots > 0n) {
        return `active credit lots (${lots}) coexist with debt (${owed})`;
      }
      return undefined;
    },
  },

  // Invariant 2: Disputing an uncredited attempt debits 0 and writes no dispute row
  {
    id: "billing.no-uncredited-debit",
    description: "disputing an uncredited attempt (amount_mismatch/failed/expired/pending) debits 0 and writes no dispute ledger row",
    when: (s) => s.configured && s.disputes.length > 0,
    optional: true,
    check(s) {
      const attemptById = new Map(s.attempts.map((a) => [a.id, a]));
      for (const row of s.ledger) {
        if (row.kind !== "dispute") continue;
        const attempt = row.attemptId ? attemptById.get(row.attemptId) : undefined;
        if (attempt && attempt.status !== "succeeded") {
          return `dispute ledger row ${row.sourceId} debited ${row.paidUc} for non-succeeded attempt ${attempt.id} (status=${attempt.status}, failure=${attempt.failureCode})`;
        }
      }
      for (const d of s.disputes) {
        if (d.attemptWasSucceeded) continue;
        const src = `dispute:${d.disputeId}`;
        const row = s.ledger.find((l) => l.kind === "dispute" && l.sourceId === src);
        if (row && BigInt(row.paidUc) !== 0n) {
          return `dispute ${d.disputeId} on uncredited attempt ${d.attemptId} wrote debit ${row.paidUc}`;
        }
      }
      return undefined;
    },
  },

  // Invariant 3: Failed / wrong-amount / blocked auto-recharge disables recharge and never loops
  {
    id: "billing.no-unbounded-recharge-loop",
    description: "wrong-amount, declined, or blocked auto-recharge disables auto-recharge and stops retrying",
    when: (s) => s.configured,
    check(s) {
      if (s.rechargeLoopViolations.length > 0) {
        return `recharge loop: ${s.rechargeLoopViolations.join("; ")}`;
      }
      const blocked = new Set(s.blockedCards.map((b) => b.fingerprint));
      if (s.rechargeEnabled && s.savedCardFingerprint && blocked.has(s.savedCardFingerprint)) {
        return `recharge_enabled=true while saved card ${s.savedCardFingerprint} is blocked`;
      }
      return undefined;
    },
  },

  // Invariant 4: Dispute exact reversal on won & warning_closed; lost retains debit; block lift rules
  {
    id: "billing.dispute-exact-reversal",
    description:
      "won and warning_closed disputes reverse the exact dispute debit and lift dispute-only block iff no other open/lost dispute or fraud warning holds it; lost keeps debit",
    when: (s) => s.configured && s.disputes.some((d) => d.closedStatus !== null),
    optional: true,
    check(s) {
      const blockedMap = new Map(s.blockedCards.map((b) => [b.fingerprint, b.reason]));
      const fraudSet = new Set(s.fraudWarnings);

      for (const d of s.disputes) {
        if (!d.closedStatus) continue;
        const src = `dispute:${d.disputeId}`;
        const debitRow = s.ledger.find((l) => l.kind === "dispute" && l.sourceId === src);
        const revRow = s.ledger.find((l) => l.kind === "dispute_reversal" && l.sourceId === src);
        const debitUc = debitRow ? BigInt(debitRow.paidUc) : 0n;
        const revUc = revRow ? BigInt(revRow.paidUc) : 0n;

        if (d.closedStatus === "won" || d.closedStatus === "warning_closed") {
          if (debitUc !== 0n && revUc !== -debitUc) {
            return `dispute ${d.disputeId} (${d.closedStatus}): debited ${debitUc} but reversed ${revUc}`;
          }
          if (d.fingerprint && !fraudSet.has(d.fingerprint)) {
            // Check whether any OTHER unreversed dispute debit exists on this fingerprint
            const hasOtherUnreversed = s.ledger.some((l) => {
              if (l.kind !== "dispute" || l.sourceId === src || BigInt(l.paidUc) === 0n) return false;
              const att = s.attempts.find((a) => a.id === l.attemptId);
              if (att?.cardFingerprint !== d.fingerprint) return false;
              return !s.ledger.some((r) => r.kind === "dispute_reversal" && r.sourceId === l.sourceId);
            });
            const blockReason = blockedMap.get(d.fingerprint);
            if (hasOtherUnreversed && !blockReason) {
              return `card ${d.fingerprint} unblocked after ${d.disputeId} despite another open/lost dispute`;
            }
            if (!hasOtherUnreversed && blockReason === "dispute") {
              return `card ${d.fingerprint} still dispute-blocked after all disputes resolved (${d.disputeId}=${d.closedStatus})`;
            }
          }
        } else if (d.closedStatus === "lost") {
          if (revUc !== 0n) {
            return `lost dispute ${d.disputeId} unexpectedly reversed ${revUc}`;
          }
        }
      }
      return undefined;
    },
  },

  // Invariant 5: Early fraud warning block is monotonic and never cleared
  {
    id: "billing.fraud-block-monotonic",
    description: "once early_fraud_warning lands on a card, its fraud block stays permanently and it cannot be saved or recharged",
    when: (s) => s.configured && s.fraudWarnings.length > 0,
    optional: true,
    check(s) {
      const blockedMap = new Map(s.blockedCards.map((b) => [b.fingerprint, b.reason]));
      for (const fp of s.fraudWarnings) {
        const reason = blockedMap.get(fp);
        if (reason !== "early_fraud_warning") {
          return `fraud-flagged card ${fp} has block reason ${reason ?? "NONE"} (expected early_fraud_warning)`;
        }
        if (s.savedCardFingerprint === fp) {
          return `fraud-flagged card ${fp} is still saved on billing_accounts`;
        }
      }
      return undefined;
    },
  },

  // Host hygiene: no unhandled rejections or uncaught exceptions
  {
    id: "billing.no-leaked-errors",
    description: "no unhandled rejections or uncaught exceptions in the billing host",
    when: (s) => s.configured,
    check: (s) => (s.leakedErrors.length ? `leaked: ${s.leakedErrors.join("; ")}` : undefined),
  },
];

export const billing = model<BillingState, BillingAction, BillingObs, BillingSnapshot>({
  id: "billing",
  description: "Nightmail Stripe money-rail: top-ups, auto-recharge, webhooks, disputes, fraud blocks, reconciliation, and refunds",
  maxSteps: 18,
  bug: "canary_ledger_drift",

  initial: () => ({
    configured: false,
    preset: null,
    attempts: 0,
    openDisputes: 0,
    totalDisputes: 0,
    hasCard: false,
    rechargeEnabled: false,
    t: 0,
  }),

  choices(s): Choice<BillingAction>[] {
    if (!s.configured) {
      return [
        choice({ op: "Configure", preset: "funded" }, 3),
        choice({ op: "Configure", preset: "autoRecharge" }, 3),
        choice({ op: "Configure", preset: "fresh" }, 2),
      ];
    }
    const out: Choice<BillingAction>[] = [
      choice({ op: "TopUp", method: "saved_card", amountCents: 2000, outcome: "paid" }, 3),
      choice({ op: "TopUp", method: "saved_card", amountCents: 2500, outcome: "card_declined" }, 2),
      choice({ op: "TopUp", method: "saved_card", amountCents: 2500, outcome: "requires_action" }, 1),
      choice({ op: "TopUp", method: "saved_card", amountCents: 2000, outcome: "stripe_5xx" }, 1),
      choice({ op: "TopUp", method: "checkout", amountCents: 2500, outcome: "paid" }, 3),
      choice({ op: "TopUp", method: "checkout", amountCents: 5000, outcome: "paid" }, 1),
      choice({ op: "SendUsage", amountCents: 1000 }, 3),
      choice({ op: "SendUsage", amountCents: 2000 }, 2),
      choice({ op: "SendUsage", amountCents: 3000 }, 1),
      choice({ op: "AutoRechargeTick", outcome: "paid" }, 3),
      choice({ op: "AutoRechargeTick", outcome: "amount_mismatch" }, 2),
      choice({ op: "AutoRechargeTick", outcome: "card_declined" }, 2),
      choice({ op: "AutoRechargeTick", outcome: "stripe_5xx" }, 1),
      choice({ op: "SaveCard", card: "A" }, 1),
      choice({ op: "SaveCard", card: "B" }, 2),
      choice({ op: "ForgetCard" }, 1),
      choice({ op: "EnableAutoRecharge" }, 2),
      choice({ op: "Wait", seconds: 360 }, 2),
      choice({ op: "Wait", seconds: 4000 }, 1),
      choice({ op: "Wait", seconds: 86400 }, 1),
    ];

    if (s.attempts > 0) {
      out.push(
        choice({ op: "WebhookInvoicePaid", target: "latest", mode: "exact" }, 3),
        choice({ op: "WebhookInvoicePaid", target: "latest", mode: "amount_mismatch" }, 2),
        choice({ op: "WebhookInvoicePaid", target: "latest", mode: "late" }, 2),
        choice({ op: "WebhookInvoicePaid", target: "latest", mode: "duplicate" }, 2),
        choice({ op: "WebhookInvoiceFailed", target: "latest" }, 2),
        choice({ op: "DisputeCreated", target: "latest", status: "needs_response" }, 3),
        choice({ op: "DisputeCreated", target: "latest", status: "warning_needs_response" }, 2),
        choice({ op: "DisputeCreated", target: "uncredited", status: "needs_response" }, 2),
        choice({ op: "DisputeCreated", target: "latest", status: "needs_response", partialCents: 1000 }, 1),
        choice({ op: "EarlyFraudWarning", target: "latest" }, 2),
        choice({ op: "ReconcileAttempt", target: "latest", stripeState: "paid" }, 2),
        choice({ op: "ReconcileAttempt", target: "latest", stripeState: "open" }, 1),
        choice({ op: "ReconcileAttempt", target: "latest", stripeState: "void" }, 1),
        choice({ op: "ReconcileAttempt", target: "latest", stripeState: "missing" }, 1),
        choice({ op: "Refund", target: "latest", outcome: "succeeded" }, 2),
        choice({ op: "Refund", target: "latest", amountCents: 1000, outcome: "succeeded" }, 1),
        choice({ op: "Refund", target: "latest", outcome: "failed" }, 1),
      );
      out.push(
        choice({ op: "DisputeCreated", target: "first", status: "needs_response" }, 1),
        choice({ op: "DisputeCreated", target: "first", status: "warning_needs_response" }, 1),
        choice({ op: "EarlyFraudWarning", target: "first" }, 1),
        choice({ op: "WebhookInvoicePaid", target: "first", mode: "exact" }, 1),
        choice({ op: "ReconcileAttempt", target: "first", stripeState: "paid" }, 1),
        choice({ op: "Refund", target: "first", outcome: "succeeded" }, 1),
        choice({ op: "Refund", target: "first", amountCents: 1000, outcome: "succeeded" }, 1),
        choice({ op: "Refund", target: "first", amountCents: 1000, outcome: "failed" }, 1),
      );
    }

    if (s.openDisputes > 0) {
      out.push(
        choice({ op: "DisputeClosed", target: "latest", status: "won" }, 3),
        choice({ op: "DisputeClosed", target: "latest", status: "warning_closed" }, 3),
        choice({ op: "DisputeClosed", target: "latest", status: "lost" }, 2),
      );
      if (s.openDisputes > 1) {
        out.push(
          choice({ op: "DisputeClosed", target: "first", status: "won" }, 2),
          choice({ op: "DisputeClosed", target: "first", status: "warning_closed" }, 1),
          choice({ op: "DisputeClosed", target: "first", status: "lost" }, 1),
        );
      }
    }

    return out;
  },

  step(s, a): Step<BillingState, BillingObs> {
    if (a.op === "Configure") {
      const cfg = BILLING_PRESETS[a.preset];
      return {
        next: {
          configured: true,
          preset: a.preset,
          attempts: cfg.initialBalanceCents > 0 ? 1 : 0,
          openDisputes: 0,
          totalDisputes: 0,
          hasCard: cfg.saveCard,
          rechargeEnabled: cfg.autoRechargeEnabled,
          t: 0,
        },
        expect: anyReply(),
      };
    }

    const next: BillingState = { ...s };
    switch (a.op) {
      case "TopUp":
        next.attempts += 1;
        break;
      case "AutoRechargeTick":
        next.attempts += 1;
        break;
      case "DisputeCreated":
        next.openDisputes += 1;
        next.totalDisputes += 1;
        break;
      case "DisputeClosed":
        next.openDisputes = Math.max(0, next.openDisputes - 1);
        break;
      case "ForgetCard":
        next.hasCard = false;
        next.rechargeEnabled = false;
        break;
      case "SaveCard":
        next.hasCard = true;
        break;
      case "EnableAutoRecharge":
        if (next.hasCard) next.rechargeEnabled = true;
        break;
      case "Wait":
        next.t += a.seconds;
        break;
      default:
        break;
    }
    return { next, expect: anyReply() };
  },

  idle: billingIdleRules,
});

export { FAIL_RECHARGE_CODES };
