import { CATALOG_OPS, type CatalogOp } from "./access.rest.types.ts";

export type AccessPreset = "core" | "full" | "race" | "revoke";

export type GrantName =
  | "grant"
  | "grant2"
  | "grant3"
  | "g-s"
  | "g-m"
  | "g-rm"
  | "g-sm"
  | "m-r"
  | "m-s";

export type CredName =
  | "key"
  | "dkey"
  | "legacy"
  | "gkey"
  | "token"
  | "token3"
  | "ikey"
  | "gikey"
  | "bkey";

export type MintName = CredName | GrantName | "box";
export type RevokeName = CredName | GrantName;
export type ProbeTarget = CredName | GrantName;
export type ProbeHow = "code" | "plain" | "call" | "delegate" | "query" | "audit" | "mcp" | "rest" | "lists";

export type CreateWhat = "list" | "apikey" | "inbox";
export type IdemKeyName = "k1" | "k2" | "kmax" | "klong" | "kbad" | "kempty";
export type BodyName = "b1" | "b2" | "bad" | "fixed";
export type SlotName = "A" | "B";

export interface GrantShape {
  readonly name: GrantName;
  readonly read: boolean;
  readonly send: boolean;
  readonly manage: boolean;
  readonly byMember: boolean;
}

export const GRANT_SHAPES: readonly GrantShape[] = [
  { name: "grant", read: true, send: true, manage: true, byMember: false },
  { name: "grant2", read: true, send: true, manage: false, byMember: true },
  { name: "grant3", read: true, send: false, manage: false, byMember: false },
  { name: "g-s", read: false, send: true, manage: false, byMember: false },
  { name: "g-m", read: false, send: false, manage: true, byMember: false },
  { name: "g-rm", read: true, send: false, manage: true, byMember: false },
  { name: "g-sm", read: false, send: true, manage: true, byMember: false },
  { name: "m-r", read: true, send: false, manage: false, byMember: true },
  { name: "m-s", read: false, send: true, manage: false, byMember: true },
] as const;

export function findGrantShape(name: string): GrantShape | undefined {
  return GRANT_SHAPES.find((s) => s.name === name);
}

export const REST_CREDS: readonly CredName[] = ["key", "dkey", "legacy", "gkey", "token", "token3"] as const;

export type AccessAction =
  | { op: "Configure"; preset: AccessPreset }
  | { op: "Mint"; target: MintName }
  | { op: "Revoke"; target: RevokeName }
  | { op: "DeleteBox" }
  | { op: "Refresh"; grant: GrantName }
  | { op: "RemoveMember" }
  | { op: "PromoteMember" }
  | { op: "NarrowKey" }
  | { op: "Probe"; who: ProbeTarget; how: ProbeHow }
  | { op: "Tick"; ms: number }
  | { op: "Create"; what: CreateWhat; cred: CredName | "grant"; key: IdemKeyName; body: BodyName; lost?: boolean }
  | { op: "SlotBegin"; slot: SlotName; what: CreateWhat; cred: CredName | "grant"; key: IdemKeyName; body: BodyName; lost?: boolean }
  | { op: "SlotStep"; slot: SlotName }
  | { op: "SlotCrash"; slot: SlotName };

export type AccessObs = Record<string, unknown>;

export interface AccessSnapshot {
  configured: boolean;
  leakedErrors: string[];
  secretReplays: string[];
  duplicateCreates: string[];
}

// ---- Pure REST & MCP authorization evaluation from documented x-nightmail-permission ----

export interface EvalActor {
  kind: "mcp" | "apiKey" | "agentToken" | "inboxKey";
  read: boolean;
  send: boolean;
  manage: boolean;
  member: boolean;
  receivingConsent: boolean;
  domainLimited: boolean;
  inboxPerms?: readonly ("read" | "send" | "modify" | "create")[];
}

function hasPerm(a: EvalActor, p: "read" | "send" | "manage"): boolean {
  if (a.manage) return true;
  if (p === "read") return a.read;
  if (p === "send") return a.send;
  return false;
}

/**
 * Whether REST authorizes `op` for `a`, derived strictly from the documented
 * `x-nightmail-permission` contract in `api/openapi.json`.
 */
export function restAllows(op: CatalogOp, a: EvalActor): boolean {
  const p = op.perm;
  if (!p) return false;

  if (a.kind === "inboxKey") {
    if (p.scope !== "address" && p.scope !== "recipient") return false;
    const perms = a.inboxPerms ?? [];
    if (p.permission === "sendEmail") return perms.includes("send");
    if (p.permission === "inboxes" && p.level === "write") return perms.includes("create");
    if (p.permission === "receivedMail" && p.level === "write") return perms.includes("modify");
    if (p.level === "read") return perms.includes("read");
    return false;
  }

  if (p.access === "any") return true;
  if (p.access === "public" || p.access === "staff") return false;
  if (p.credential === "dashboard") return false;
  if (p.credential === "signIn" && a.kind !== "mcp") return false;
  if (p.credential === "lasting" && a.kind === "agentToken") return false;
  if (p.person === "admin" && a.member) return false;
  if (p.person === "owner" && a.member) return false;

  // People-only operations (members, invitations, Activity, agent-token minting)
  if (!p.permission) {
    if (a.kind !== "mcp") return false;
    if (p.level === "write") return a.manage;
    return hasPerm(a, "read");
  }

  // Received mail reads: an API key limited to sender domains reads the mail addressed to them with read (core.ts
  // domainMailAccess); any other workspace credential as an address-scoped mailbox path.
  if (p.scope === "recipient") return a.domainLimited ? a.kind === "apiKey" && hasPerm(a, "read") : a.manage;

  // Scope restrictions for domain-limited keys
  if (a.domainLimited && (p.scope === "workspace" || p.scope === "address")) {
    return false;
  }

  // Address-scoped mailbox paths for workspace credentials require manage
  if (p.scope === "address") {
    return a.manage;
  }

  // Receiving rules: read needs read+receivingConsent (owner/admin MCP) or manage; write needs manage
  if (p.permission === "receivingRules") {
    if (p.level === "write") return a.manage;
    return a.receivingConsent ? hasPerm(a, "read") : a.manage;
  }

  // Configuration: delegatedLevel "write" means MCP sign-ins and agent tokens need manage while API keys need read
  if (p.permission === "configuration") {
    if (p.level === "write") return a.manage;
    if (p.delegatedLevel === "write" && a.kind !== "apiKey") return a.manage;
    return hasPerm(a, "read");
  }

  if (p.permission === "sendEmail") return hasPerm(a, "send");
  if (p.permission === "inboxes") return a.manage;
  if (p.permission === "audience" || p.permission === "sentMail") {
    return p.level === "write" ? a.manage : hasPerm(a, "read");
  }
  return a.manage;
}

/**
 * Whether /mcp should list `op` for `a`:
 * - For workspace credentials: exactly what REST authorizes.
 * - For address/inbox keys: MCP policy exposes only agent-inbox tools (`op.inbox`) except `createInboundThread`.
 */
export function mcpVisible(op: CatalogOp, a: EvalActor): boolean {
  if (a.kind === "inboxKey") {
    if (op.name === "createInboundThread") return false;
    if (!op.inbox) return false;
    return (a.inboxPerms ?? []).includes(op.inbox);
  }
  return restAllows(op, a);
}

export function visibleMap(a: EvalActor): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const op of CATALOG_OPS) {
    if (mcpVisible(op, a)) out[op.name] = true;
  }
  return out;
}

export function restGetsMap(a: EvalActor): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const op of CATALOG_OPS) {
    if (op.method === "get") out[op.name] = restAllows(op, a);
  }
  return out;
}
