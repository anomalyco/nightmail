export type DeliveryPreset = "retries1" | "retries0" | "retries2" | "retries9";

export interface DeliveryCfg {
  preset: DeliveryPreset;
  /** Endpoint retryAttempts for W, V and U (S and F always use default 9). */
  retries: number;
}

export const DELIVERY_PRESETS: Record<DeliveryPreset, DeliveryCfg> = {
  retries1: { preset: "retries1", retries: 1 },
  retries0: { preset: "retries0", retries: 0 },
  retries2: { preset: "retries2", retries: 2 },
  retries9: { preset: "retries9", retries: 9 },
};

export const WORKERS = ["K", "L"] as const;
export type WorkerName = (typeof WORKERS)[number];

export const ENDPOINTS = ["W", "V", "S", "F", "U"] as const;
export type EndpointName = (typeof ENDPOINTS)[number];

export type RateEndpointName = "W" | "V" | "S" | "F";

export type RouteName = "r1" | "r2" | "r3";
export type RouteState = "on" | "off" | "drop";

export const RITUAL_MODES = ["none", "slack", "forward", "both", "four", "max", "over"] as const;
export type RitualMode = (typeof RITUAL_MODES)[number];

export const MSG_VARIANTS = ["plain", "loop", "recv24", "recv25"] as const;
export type MsgVariant = (typeof MSG_VARIANTS)[number];

export type RcptKey = "a" | "x" | "z" | "b";

export const RESPONSES = [
  "200",
  "503",
  "429 120",
  "400",
  "timeout",
  "408",
  "410",
  "429",
  "429 9999999",
  "reset",
] as const;
export type ResponseKind = (typeof RESPONSES)[number];

export type DeliveryAction =
  | { op: "Configure"; preset: DeliveryPreset }
  | { op: "Ingest"; m: string; rcpts: RcptKey[]; variant: MsgVariant }
  | { op: "Run"; w: WorkerName; d: string; gate: boolean }
  | { op: "Go"; w: WorkerName }
  | { op: "Reply"; w: WorkerName; resp: string }
  | { op: "Crash"; w: WorkerName; sent: boolean }
  | { op: "Expire"; d: string }
  | { op: "Tick" }
  | { op: "Pause"; e: EndpointName; on: boolean }
  | { op: "Delete"; e: EndpointName }
  | { op: "Rituals"; mode: RitualMode }
  | { op: "RouteSet"; r: RouteName; state: RouteState }
  | { op: "Rate"; e: RateEndpointName; n: 1 | 60 }
  | { op: "Decline" }
  | { op: "Age"; d: string }
  | { op: "Prune" }
  | { op: "Strip"; m: string }
  | { op: "Drain" };

export type DeliveryRowView = [
  status: string,
  count: number,
  err: string | null,
  fence: string | null,
  job: [string, number] | null,
  delay: number | "d" | null,
];

export interface DeliveryView {
  b: Record<string, string[]>;
  d: Record<string, DeliveryRowView>;
  e: Record<string, [boolean, boolean]>;
  f: string[];
  fs: number;
}

export type SendTuple = [ep: string, delivery: string | null, keyed: boolean];

export interface DeliveryObs {
  r: unknown;
  sends: SendTuple[];
  view: DeliveryView;
}

export interface DeliverySnapshot {
  configured: boolean;
  retries: number;
  /** Cumulative observed sends per delivery label (checked by delivery.attempts). */
  sendCounts: Record<string, number>;
  /** Observed (msg, ep) deliveries that vanished without endpoint deletion or settled prune (delivery.kept). */
  lostDeliveries: string[];
  /** Duplicate delivery row labels (base#2, etc.) observed in DB. */
  duplicateDeliveries: string[];
  /** Number of Drain actions executed in this trial. */
  drainCount: number;
  /** Deliveries not in delivered|failed|paused or with pending/running job after Drain (delivery.settles). */
  unsettledAfterDrain: string[];
  /** Unhandled rejections or uncaught exceptions in the host. */
  leakedErrors: string[];
}

export function emailOf(m: string): string {
  return m.startsWith("d") ? `m${m.slice(1)}` : m;
}

export function epOfDelivery(label: string): string {
  const part = label.split(":")[1] ?? "S";
  return part[0] ?? "S";
}

export function maxAttemptsFor(ep: string, retries: number): number {
  return 1 + (ep === "W" || ep === "V" || ep === "U" ? retries : 9);
}

export function isReplaySafe(ep: string): boolean {
  return ep === "V" || ep === "F" || ep === "U";
}

export function isPlainSub(ep: string): boolean {
  return ep === "U";
}

export function isKeyed(ep: string): boolean {
  return ep !== "S" && ep !== "U";
}
