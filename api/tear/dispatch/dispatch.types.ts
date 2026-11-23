export type Persona = "ok" | "thr" | "rej" | "unk";

export type DispatchPreset =
  | "core"
  | "paced"
  | "throttle"
  | "pendingCap"
  | "owners"
  | "allowance"
  | "allowance2"
  | "quota2"
  | "quota3"
  | "quota4";

export interface DispatchCfg {
  preset: DispatchPreset;
  /** Queued direct mail already counted against the pending cap (sending_stream_depth seed). */
  seed: number;
  /** Campaign daily cap (pace_per_day), set below the API's 100 minimum to reach it. */
  pace: number | null;
  /** Provider behaviour of every campaign recipient, and how many there are. */
  campaign: Persona;
  recipients: number;
  /** SES 24-hour quota with two dispatcher shards (invariant-checked, not step-predicted). */
  quota: number | null;
  /** Workspaces sending into the region, and rows per runner lease. */
  owners: number;
  drainBatch: number;
  /** SES 24-hour quota predicted exactly for the runner alone (allowance profiles). */
  exactQuota: number | null;
}

const exactCfg = (
  preset: DispatchPreset,
  seed: number,
  pace: number | null,
  campaign: Persona,
  overrides: Partial<DispatchCfg> = {},
): DispatchCfg => ({
  preset,
  seed,
  pace,
  campaign,
  recipients: 2,
  quota: null,
  owners: 1,
  drainBatch: 24,
  exactQuota: null,
  ...overrides,
});

const quotaCfg = (preset: DispatchPreset, q: number): DispatchCfg => ({
  preset,
  seed: 0,
  pace: null,
  campaign: "ok",
  recipients: 4,
  quota: q,
  owners: 1,
  drainBatch: 24,
  exactQuota: null,
});

export const DISPATCH_PRESETS: Record<DispatchPreset, DispatchCfg> = {
  core: exactCfg("core", 0, null, "ok"),
  paced: exactCfg("paced", 0, 1, "ok"),
  throttle: exactCfg("throttle", 0, null, "thr"),
  pendingCap: exactCfg("pendingCap", 9998, null, "unk"),
  owners: exactCfg("owners", 0, null, "ok", { owners: 2, drainBatch: 2 }),
  allowance: exactCfg("allowance", 0, null, "ok", { exactQuota: 2 }),
  allowance2: exactCfg("allowance2", 0, null, "ok", { owners: 2, drainBatch: 2, exactQuota: 2 }),
  quota2: quotaCfg("quota2", 2),
  quota3: quotaCfg("quota3", 3),
  quota4: quotaCfg("quota4", 4),
};

export const PRESET_NAMES = Object.keys(DISPATCH_PRESETS) as DispatchPreset[];

export type WaitSeconds = 1 | 4 | 59 | 60 | 86400;
export type InstName = "D1" | "D2";

export type DispatchAction =
  | { op: "Configure"; preset: DispatchPreset }
  | { op: "Wait"; seconds: WaitSeconds }
  | { op: "Send"; persona: Persona }
  | { op: "Send2"; persona: Persona }
  | { op: "SendMarketing"; cost: 1 | 2; second: boolean }
  | { op: "SendKey"; key: "k1" | "k2"; persona: "ok" | "rej" }
  | { op: "DupKey"; key: "k2"; persona: "ok" }
  | { op: "Launch" }
  | { op: "Schedule" }
  | { op: "Pause" }
  | { op: "Resume" }
  | { op: "Cancel" }
  | { op: "Jobs" }
  | { op: "Drain" }
  | { op: "Recover" }
  | { op: "Step"; inst: InstName }
  | { op: "Crash"; inst: InstName }
  | { op: "Settle" }
  | { op: "SesPause"; paused: boolean };

export type MailStatus =
  | "queued"
  | "attempting"
  | "accepted"
  | "rejected"
  | "acceptance_unknown"
  | "canceled";

export type CampaignStatus =
  | "draft"
  | "preparing"
  | "scheduled"
  | "sending"
  | "paused"
  | "done"
  | "canceled";

export type DispatchObs =
  | {
      r: unknown;
      mail: Record<string, [string, number]>;
      campaign: [string, number, number];
      d: Record<string, string>;
    }
  | { invariants: true };

export interface SendLogEntry {
  at: number;
  proc: string;
  mail: string;
  out: string;
  campaign: boolean;
  since?: number;
}

export interface ReleaseLogEntry {
  at: number;
  windowStart: number | null;
  windowN: number;
  pace: number | null;
  expanded: number;
}

export interface DispatchSnapshot {
  configured: boolean;
  quota: number;
  seed: number;
  depth: number;
  queued: number;
  withinDay: number;
  marketingWithinDay: number;
  doubleSends: string[];
  leakedErrors: string[];
  sentAfterCancel: string[];
  unknownSesEmails: string[];
  pauseExpiredEarly: string[];
  spins: string[];
  asleepWithDue: string[];
  stuckAfterSettle: string[];
  dispatcherErrors: string[];
  sendLog: SendLogEntry[];
  releaseLog: ReleaseLogEntry[];
}
