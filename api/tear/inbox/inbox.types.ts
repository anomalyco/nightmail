export const ROLES = ["archive", "inbox", "junk", "sent", "trash"] as const;
export type RoleName = (typeof ROLES)[number];
export type ActiveRole = "inbox" | "archive" | "trash" | "sent";

export const BOXES = ["A", "B"] as const;
export type BoxName = (typeof BOXES)[number];

export const CONNS = ["I", "J", "W", "V"] as const;
export type ConnName = (typeof CONNS)[number];
export type IngestConn = "I" | "J";
export type WriterConn = "W" | "V";

export type ArrivingMsg = "m1" | "m2" | "m3" | "d1";
export type ClientMsg = "m1" | "m2" | "m3";
export type Recips = "a" | "b" | "ab";
export type ThreadKind = "archive" | "unarchive" | "trash" | "untrash" | "read" | "unread";

export type InboxPreset = "full" | "quota1" | "unlimited" | "core";

export interface InboxCfg {
  preset: InboxPreset;
  /** Number of distinct inbound messages in the alphabet (1 or 3; 3 also enables duplicate d1). */
  msgs: 1 | 3;
  /** Inbox A's message quota (null = unlimited). Inbox B is always unlimited. */
  quota: number | null;
  /** Smaller alphabet matching the legacy depth-3 exhaustive edge run. */
  core: boolean;
}

export const INBOX_PRESETS: Record<InboxPreset, InboxCfg> = {
  full: { preset: "full", msgs: 3, quota: 2, core: false },
  quota1: { preset: "quota1", msgs: 3, quota: 1, core: false },
  unlimited: { preset: "unlimited", msgs: 3, quota: null, core: false },
  core: { preset: "core", msgs: 1, quota: 1, core: true },
};

export const PRESET_NAMES = Object.keys(INBOX_PRESETS) as InboxPreset[];

export type InboxAction =
  | { op: "Configure"; preset: InboxPreset }
  | { op: "Accept"; conn?: WriterConn; msg: ArrivingMsg; recips: Recips }
  | { op: "Claim"; conn: IngestConn; msg: ArrivingMsg }
  | { op: "StoreClaimed"; conn: IngestConn }
  | { op: "StoreAuto"; msg: ArrivingMsg }
  | { op: "Commit"; conn: ConnName }
  | { op: "Abort"; conn: ConnName }
  | { op: "Seen"; conn?: WriterConn; box: BoxName; msg: ClientMsg }
  | { op: "Unseen"; conn?: WriterConn; box: BoxName; msg: ClientMsg }
  | { op: "Flag"; conn?: WriterConn; box: BoxName; msg: ClientMsg }
  | { op: "Del"; conn?: WriterConn; box: BoxName; msg: ClientMsg; role: ActiveRole }
  | { op: "Undel"; conn?: WriterConn; box: BoxName; msg: ClientMsg; role: ActiveRole }
  | { op: "Move"; conn?: WriterConn; box: BoxName; msg: ClientMsg; src: ActiveRole; dst: ActiveRole }
  | { op: "Copy"; conn?: WriterConn; box: BoxName; msg: ClientMsg; src: ActiveRole; dst: ActiveRole }
  | { op: "Trash"; conn?: WriterConn; box: BoxName; msg: ClientMsg; role: ActiveRole }
  | { op: "Expunge"; conn?: WriterConn; box: BoxName; msg: ClientMsg; role: ActiveRole }
  | { op: "Purge"; conn?: WriterConn; box: BoxName; role: ActiveRole }
  | { op: "Subscribe"; conn?: WriterConn; box: BoxName }
  | { op: "Delete"; conn?: WriterConn; box: BoxName }
  | { op: "Thread"; box: BoxName; msg: ClientMsg; kind: ThreadKind }
  | { op: "Send"; box: BoxName }
  | { op: "Folders"; box: BoxName }
  | { op: "Sync"; box: BoxName }
  | { op: "SyncAhead"; box: BoxName }
  | { op: "Get"; box: BoxName; msg: ClientMsg }
  | { op: "Cas"; box: BoxName; msg: ClientMsg }
  | { op: "ReadOnly"; box: BoxName; msg: ClientMsg }
  | { op: "Sweep" }
  | { op: "Age" }
  | { op: "Prune" };

export type BoxView =
  | { st: 2 }
  | {
      st: 0 | 1;
      ms: number;
      fl: number;
      n: number;
      by: number;
      h: number;
      f: ([number, number, number, number] | null)[];
      e: [RoleName, number, string, number, boolean][];
      m: Record<string, [boolean, boolean, number, boolean]>;
      v: [RoleName, number, string, number][];
      t: Record<string, [number, number]>;
    };

export interface InboxView {
  A: BoxView;
  B: BoxView;
  r: Record<string, [boolean, string | null]>;
}

export interface InboxObs {
  r: unknown;
  woke: Record<string, unknown>;
  view: InboxView;
}

export interface RawFolderRow {
  role: string;
  uidValidity: string;
  uidNext: number;
  highestModseq: number;
  total: number;
  unseen: number;
}

export interface RawEntryRow {
  role: string;
  uid: number;
  mid: string;
  modseq: number;
  deleted: boolean;
}

export interface RawMemberRow {
  mid: string;
  read: boolean;
  flagged: boolean;
  modseq: number;
  held: boolean;
  threadId: string;
  sizeBytes: number;
}

export interface RawVanishedRow {
  role: string;
  uid: number;
  mid: string;
  modseq: number;
}

export interface RawThreadRow {
  threadId: string;
  label: string;
  messageCount: number;
  unreadCount: number;
}

export interface RawBoxSnapshot {
  box: BoxName;
  exists: boolean;
  ended: boolean;
  modseq: number;
  messages: number;
  bytes: number;
  held: number;
  folders: RawFolderRow[];
  entries: RawEntryRow[];
  members: RawMemberRow[];
  vanished: RawVanishedRow[];
  threads: RawThreadRow[];
}

export interface InboxSnapshot {
  configured: boolean;
  boxes: RawBoxSnapshot[];
  /** Distinct UIDVALIDITY values observed while each inbox was live (!ended), keyed by "A/inbox" etc. */
  validitySeen: Record<string, string[]>;
  leakedErrors: string[];
}
