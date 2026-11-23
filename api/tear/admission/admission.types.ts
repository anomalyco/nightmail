export type AdmissionProfile = "recv" | "send" | "upload";

export type AdmissionPreset =
  | "recv0"
  | "recv1"
  | "recv2"
  | "recv3"
  | "send0"
  | "send1"
  | "upload0"
  | "upload1";

export type RecvCfg = {
  preset: "recv0" | "recv1" | "recv2" | "recv3";
  profile: "recv";
  /** Per-workspace [message limit, backlog] for A and B. */
  limits: [[number, number], [number, number]];
};

export type SendCfg = {
  preset: "send0" | "send1";
  profile: "send";
  caps: [number, number, number];
  headroom: number;
  rate: number;
};

export type UploadCfg = {
  preset: "upload0" | "upload1";
  profile: "upload";
  room: number;
};

export type AdmissionCfg = RecvCfg | SendCfg | UploadCfg;

export const ADMISSION_PRESETS: Record<AdmissionPreset, AdmissionCfg> = {
  recv0: { preset: "recv0", profile: "recv", limits: [[2, 2], [2, 2]] },
  recv1: { preset: "recv1", profile: "recv", limits: [[1, 5], [5, 1]] },
  recv2: { preset: "recv2", profile: "recv", limits: [[3, 1], [3, 1]] },
  recv3: { preset: "recv3", profile: "recv", limits: [[0, 5], [1, 1]] },
  send0: { preset: "send0", profile: "send", caps: [2, 3, 5], headroom: 50, rate: 4 },
  send1: { preset: "send1", profile: "send", caps: [1, 2, 4], headroom: 0, rate: 2 },
  upload0: { preset: "upload0", profile: "upload", room: 2 },
  upload1: { preset: "upload1", profile: "upload", room: 1 },
};

export const PRESET_NAMES = Object.keys(ADMISSION_PRESETS) as AdmissionPreset[];

export type ConnName = "W" | "V" | "X";
export type SendConnName = "W" | "V";
export type RecvWs = "A" | "B";
export type RecvMsg = "m1" | "m2" | "m3";
export type RecvRcptSet = "a" | "ab" | "b" | "ac" | "h" | "x" | "0";
export type LegacyRcptSet = "a" | "ac" | "h" | "x";
export type StashRcptSet = "a" | "ac" | "ab" | "b";
export type SendKey = 1 | 2 | 3;
export type SendWs = 1 | 2;
export type EmailLabel = "e1" | "e2" | "e3" | "e4" | "e5" | "e6";
export type EmailOutcome = "sent" | "suppressed" | "rejected" | "canceled";
export type UploadSlot = "U1" | "U2" | "U3";
export type AttachmentLabel = "a1" | "a2" | "a3" | "a4";

export type AdmissionAction =
  | { op: "Configure"; preset: AdmissionPreset }
  | { op: "Commit"; conn: ConnName }
  | { op: "Abort"; conn: ConnName }
  // recv
  | { op: "Accept"; msg: RecvMsg; rcpts: RecvRcptSet; conn?: ConnName }
  | { op: "LegacyAccept"; msg: RecvMsg; rcpts: LegacyRcptSet; conn?: ConnName }
  | { op: "Release"; conn?: ConnName }
  | { op: "Replay"; conn?: ConnName }
  | { op: "Stash"; msg: RecvMsg; rcpts: StashRcptSet }
  | { op: "Claim"; ws: RecvWs; msg: RecvMsg }
  | { op: "Done"; ws: RecvWs; msg: RecvMsg }
  | { op: "Fail"; ws: RecvWs; msg: RecvMsg }
  | { op: "Lose"; ws: RecvWs; msg: RecvMsg }
  | { op: "LegacyFail"; ws: RecvWs; msg: RecvMsg }
  | { op: "Recover" }
  | { op: "Days" }
  // shared recv + send
  | { op: "Hour" }
  // send
  | { op: "Send"; key: SendKey; count: 1 | 2 | 3; kind: "t" | "m"; conn?: SendConnName }
  | { op: "Batch"; key: SendKey; conn?: SendConnName }
  | { op: "Idem"; key: SendKey; idemKey: "k1"; conn?: SendConnName }
  | { op: "IdemOther"; key: SendKey; idemKey: "k1"; conn?: SendConnName }
  | { op: "Limits"; ws: SendWs; sendCap: number | null; pendCap: number | null; conn?: SendConnName }
  | { op: "Exempt"; ws: SendWs; on: boolean; conn?: SendConnName }
  | { op: "Pause"; ws: SendWs; conn?: SendConnName }
  | { op: "Resume"; ws: SendWs; conn?: SendConnName }
  | { op: "Me"; key: 1 | 2 }
  | { op: "Outcome"; email: EmailLabel; outcome: EmailOutcome }
  | { op: "History"; ws: SendWs; count: 100 | 900 }
  | { op: "H23" }
  | { op: "Minute" }
  | { op: "Week" }
  // upload
  | { op: "Upload"; slot: UploadSlot; idemKey?: "k1"; other?: boolean }
  | { op: "PutOk"; slot: UploadSlot }
  | { op: "PutFail"; slot: UploadSlot }
  | { op: "PutCrash"; slot: UploadSlot }
  | { op: "Expire" }
  | { op: "Sweep" }
  | { op: "Purge" }
  | { op: "Day" }
  | { op: "Foreign" }
  | { op: "Delete"; attachment: AttachmentLabel };

export interface AdmissionObs {
  r: unknown;
  woke: Record<string, unknown>;
  view: unknown;
}

export interface RecvWsSnapshot {
  ws: RecvWs;
  limit: number;
  backlog: number;
  windowHourMatches: boolean;
  windowCount: number;
  activeCounter: number;
  recountActiveJobs: number;
  jobsPerReceipt: Record<string, number>;
}

export interface SendWsSnapshot {
  ws: string;
  liveUsage: number;
  chargedRecipients: number;
}

export interface UploadSnapshot {
  usageBytes: number;
  recountBytes: number;
  limitBytes: number;
  deletedForeign: string[];
  agedOrphans: string[];
}

export interface AdmissionSnapshot {
  configured: boolean;
  profile: AdmissionProfile | null;
  leakedErrors: string[];
  recv: RecvWsSnapshot[];
  send: SendWsSnapshot[];
  upload: UploadSnapshot | null;
}
