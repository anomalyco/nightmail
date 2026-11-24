export type ConsentPreset = "core" | "bulkLimit" | "rateLimit";

export type ContactSlot = "c1" | "c2" | "c3" | "c4";
export type ListSlot = "L1" | "L2";

export type ConsentAction =
  | { op: "Configure"; preset: ConsentPreset }
  | { op: "CreateContact"; slot: ContactSlot }
  | { op: "UpdateProfile"; slot: ContactSlot; name: "Alice" | "Bob" }
  | { op: "DeleteContact"; slot: ContactSlot }
  | { op: "SetConsentApi"; slot: ContactSlot; status: "subscribed" | "unsubscribed"; staleTimestamp?: boolean }
  | { op: "ConfirmResubscribeApi"; slot: ContactSlot; staleTimestamp?: boolean }
  | { op: "AddToList"; slot: ContactSlot; list: ListSlot }
  | { op: "RemoveFromList"; slot: ContactSlot; list: ListSlot }
  | { op: "ImportCommit"; slots: ContactSlot[]; list?: ListSlot; attested: boolean }
  | { op: "PlanBulkConsent"; status: "subscribed" | "unsubscribed" }
  | { op: "ApplyBulkPlan"; confirmResubscribe: boolean }
  | { op: "UnsubscribeGet"; slot: ContactSlot }
  | { op: "UnsubscribeOneClick"; slot: ContactSlot }
  | { op: "UnsubscribeFooter"; slot: ContactSlot }
  | { op: "FeedbackSuppress"; slot: ContactSlot; kind: "hard_bounce" | "complaint" | "email_validation"; tsOffsetSec: 0 | 60 | 120 }
  | { op: "ManualSuppress"; slot: ContactSlot }
  | { op: "LaunchCampaign"; list: ListSlot }
  | { op: "ExpandCampaign" }
  | { op: "DispatchCampaign" }
  | { op: "RaceImportAndUnsub"; slot: ContactSlot }
  | { op: "RacePlanApplyAndUnsub"; slot: ContactSlot }
  | { op: "RaceStaleResubscribeAndUnsub"; slot: ContactSlot }
  | { op: "RaceFeedbackOrderCheck"; slot: ContactSlot }
  | { op: "CheckLimits"; kind: "bulk10k" | "import50k" | "importProps51" | "previewCap50" | "rateLimit" | "props16k" }
  | { op: "RunRetentionScrub" }
  | { op: "VerifyAll" };

export interface ConsentObs {
  status: number;
  code: string | null;
  retryable: boolean | null;
  detail?: string | null;
}

export interface ConsentSnapshot {
  configured: boolean;
  overrideViolations: string[];
  serializabilityViolations: string[];
  blockedSendViolations: string[];
  evidenceViolations: string[];
  tallyViolations: string[];
  workspaceViolations: string[];
  limitViolations: string[];
  leakedErrors: string[];
}
