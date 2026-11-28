export type BillingPreset = "funded" | "autoRecharge" | "fresh";

export interface BillingPresetCfg {
  preset: BillingPreset;
  initialBalanceCents: number;
  saveCard: boolean;
  autoRechargeEnabled: boolean;
  thresholdCents: number;
  rechargeAmountCents: number;
  monthlyCapCents: number;
}

export const BILLING_PRESETS: Record<BillingPreset, BillingPresetCfg> = {
  funded: {
    preset: "funded",
    initialBalanceCents: 2500,
    saveCard: true,
    autoRechargeEnabled: false,
    thresholdCents: 1000,
    rechargeAmountCents: 2500,
    monthlyCapCents: 10_000,
  },
  autoRecharge: {
    preset: "autoRecharge",
    initialBalanceCents: 500,
    saveCard: true,
    autoRechargeEnabled: true,
    thresholdCents: 1000,
    rechargeAmountCents: 2500,
    monthlyCapCents: 10_000,
  },
  fresh: {
    preset: "fresh",
    initialBalanceCents: 0,
    saveCard: false,
    autoRechargeEnabled: false,
    thresholdCents: 1000,
    rechargeAmountCents: 2500,
    monthlyCapCents: 10_000,
  },
};

export type TopUpOutcome = "paid" | "requires_action" | "card_declined" | "stripe_5xx";
export type RechargeOutcome = "paid" | "amount_mismatch" | "card_declined" | "stripe_5xx";
export type TargetAttempt = "latest" | "first" | "uncredited";
export type DisputeOpenStatus = "needs_response" | "warning_needs_response";
export type DisputeCloseStatus = "won" | "lost" | "warning_closed";
export type RefundOutcome = "succeeded" | "failed" | "stripe_5xx";

export type BillingAction =
  | { op: "Configure"; preset: BillingPreset }
  | {
      op: "TopUp";
      method: "saved_card" | "checkout";
      amountCents: 2000 | 2500 | 5000;
      outcome: TopUpOutcome;
      reuseKey?: boolean;
    }
  | { op: "SendUsage"; amountCents: 1000 | 2000 | 3000 }
  | { op: "AutoRechargeTick"; outcome: RechargeOutcome }
  | {
      op: "WebhookInvoicePaid";
      target: "latest" | "first";
      mode: "exact" | "amount_mismatch" | "late" | "duplicate";
    }
  | { op: "WebhookInvoiceFailed"; target: "latest" }
  | {
      op: "DisputeCreated";
      target: TargetAttempt;
      status: DisputeOpenStatus;
      partialCents?: 1000;
    }
  | { op: "DisputeClosed"; target: "latest" | "first"; status: DisputeCloseStatus }
  | { op: "EarlyFraudWarning"; target: "latest" | "first" }
  | { op: "ReconcileAttempt"; target: "latest" | "first"; stripeState: "paid" | "open" | "void" | "missing" }
  | { op: "ForgetCard" }
  | { op: "SaveCard"; card: "A" | "B" }
  | { op: "EnableAutoRecharge" }
  | { op: "Refund"; target: "latest" | "first"; amountCents?: 1000; outcome: RefundOutcome }
  | { op: "Wait"; seconds: 360 | 4000 | 86400 };

export interface BillingObs {
  status: number;
  code: string | null;
  balanceUc: string;
  promoUc: string;
  rechargeEnabled: boolean;
  rechargeDisabledReason: string | null;
  hasSavedCard: boolean;
  attemptCount: number;
  disputeCount: number;
}

export interface LedgerEntrySnap {
  id: string;
  kind: string;
  sourceId: string;
  paidUc: string;
  promoUc: string;
  balanceAfterUc: string;
  promoAfterUc: string;
  attemptId: string | null;
}

export interface AttemptSnap {
  id: string;
  kind: string;
  status: string;
  amountUc: string;
  refundedUc: string;
  failureCode: string | null;
  cardFingerprint: string | null;
}

export interface DisputeTrack {
  disputeId: string;
  attemptId: string;
  fingerprint: string | null;
  openedStatus: DisputeOpenStatus;
  closedStatus: DisputeCloseStatus | null;
  attemptWasSucceeded: boolean;
}

export interface BillingSnapshot {
  configured: boolean;
  balanceUc: string;
  promoUc: string;
  activeLotsRemainingUc: string;
  activeLotCount: number;
  rechargeEnabled: boolean;
  rechargeDisabledReason: string | null;
  rechargeDisabledAt: string | null;
  rechargePendingAttempt: string | null;
  savedCardFingerprint: string | null;
  ledger: LedgerEntrySnap[];
  attempts: AttemptSnap[];
  blockedCards: { fingerprint: string; reason: string }[];
  disputes: DisputeTrack[];
  fraudWarnings: string[];
  rechargeLoopViolations: string[];
  leakedErrors: string[];
}
