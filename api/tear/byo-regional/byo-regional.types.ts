export type ByoPreset = "readyToImport" | "fresh" | "hosted";
export type ByoRegion = "us-east-2" | "us-east-1";
export type RegionFault = "ok" | "wait_sns_confirm" | "retryable_5xx" | "access_denied";
export type DisconnectFault = "ok" | "retryable_5xx" | "access_denied" | "pause_mid_disconnect";
export type DomainSlot = "alpha" | "beta" | "gamma";

export type ByoAction =
  | { op: "Configure"; preset: ByoPreset }
  | { op: "SetRegionFault"; region: ByoRegion; fault: RegionFault }
  | { op: "SetDisconnectFault"; fault: DisconnectFault }
  | { op: "Connect" }
  | { op: "SelectImports"; region: ByoRegion; domain: "alpha" | "beta" }
  | { op: "NewRegionalDomain"; region: ByoRegion; domain: DomainSlot }
  | { op: "ProvisionStep"; region: ByoRegion; runToExhaustion?: boolean }
  | { op: "ConfirmTopic"; region: ByoRegion }
  | { op: "BindStep"; region: ByoRegion; runToExhaustion?: boolean }
  | { op: "OperatorPause"; reasonless?: boolean }
  | { op: "OperatorResume" }
  | { op: "Disconnect" }
  | { op: "DisconnectStep" }
  | { op: "Verify" };

export interface ByoObs {
  status: number;
  code: string | null;
  connectionState: string | null;
  paused: boolean;
  regions: Record<ByoRegion, { sendingState: string; error: string | null }>;
  openIntents: number;
  boundDomains: number;
}

export interface RegionSnap {
  region: string;
  sendingState: string;
  scanState: string;
  provisionError: string | null;
  provisionJobStatus: string | null;
  journalCount: number;
}

export interface IntentSnap {
  id: string;
  region: string;
  name: string;
  importing: boolean;
  closedReason: string | null;
  regionSendingState: string;
  provisionJobStatus: string | null;
  bindJobStatus: string | null;
}

export interface ByoSnapshot {
  configured: boolean;
  connectionExists: boolean;
  connectionId: string | null;
  connectionState: string | null;
  pausedAt: string | null;
  pauseReason: string | null;
  wasPausedBeforeLastDelete: boolean;
  regions: RegionSnap[];
  intents: IntentSnap[];
  boundDomains: { name: string; region: string }[];
  pausedDeleteViolations: string[];
  disconnectingMutationViolations: string[];
  exhaustedRecoveryViolations: string[];
  leakedErrors: string[];
}
