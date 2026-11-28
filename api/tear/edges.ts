/**
 * Generates an exhaustive edge-covering campaign JSON for any of the 9 core tear models.
 *
 * Performs a bounded BFS on the pure model's state graph (matching the old Rust checkers' core
 * edge-coverage profiles), then packs 100% of every discovered (state, action) edge into a compact
 * set of edge-covering traces via greedy edge-chaining so every edge runs on the real host with
 * minimal resets.
 *
 * Usage:
 *   bun edges.ts <dispatch|ses|access|admission|inbox|delivery|campaign-lifecycle|billing|byo-regional> <out.json>
 */
import { writeFileSync } from "node:fs";
import type { Model } from "@tear/mbt";
import { dispatch } from "./dispatch/dispatch.model.ts";
import { ses } from "./ses/ses.model.ts";
import { access } from "./access/access.model.ts";
import { admission } from "./admission/admission.model.ts";
import { inbox } from "./inbox/inbox.model.ts";
import { delivery } from "./delivery/delivery.model.ts";
import { campaignLifecycle } from "./campaign-lifecycle/campaign-lifecycle.model.ts";
import { billing } from "./billing/billing.model.ts";
import { byoRegional } from "./byo-regional/byo-regional.model.ts";

interface EdgeProfile {
  name: string;
  starts: unknown[][];
  maxDepth: number;
  maxStates: number;
  filter?: (action: any) => boolean;
}

const MODELS: Record<string, { model: Model<any, any, any, any>; profiles: EdgeProfile[] }> = {
  dispatch: {
    model: dispatch,
    profiles: [
      {
        name: "core-d2",
        starts: [[{ op: "Configure", preset: "core" }]],
        maxDepth: 2,
        maxStates: 400,
      },
      {
        name: "throttle-paced-d2",
        starts: [
          [{ op: "Configure", preset: "throttle" }],
          [{ op: "Configure", preset: "paced" }],
        ],
        maxDepth: 2,
        maxStates: 250,
        filter: (a) => !["Send2", "SendMarketing", "SendKey", "DupKey"].includes(a.op),
      },
    ],
  },
  ses: {
    model: ses,
    profiles: [
      {
        name: "core-d2",
        starts: [[]],
        maxDepth: 2,
        maxStates: 450,
        filter: (a) => !a.old && a.op !== "Pair",
      },
    ],
  },
  access: {
    model: access,
    profiles: [
      {
        name: "core-d2",
        starts: [[{ op: "Configure", preset: "core" }]],
        maxDepth: 2,
        maxStates: 200,
      },
      {
        name: "race-d4",
        starts: [[{ op: "Configure", preset: "race" }]],
        maxDepth: 4,
        maxStates: 250,
      },
      {
        name: "revoke-d5",
        starts: [[{ op: "Configure", preset: "revoke" }]],
        maxDepth: 5,
        maxStates: 150,
      },
    ],
  },
  admission: {
    model: admission,
    profiles: [
      {
        name: "recv0-d2",
        starts: [[{ op: "Configure", preset: "recv0" }]],
        maxDepth: 2,
        maxStates: 300,
        filter: (a) => !a.conn && a.rcpts !== "h" && a.rcpts !== "x",
      },
      {
        name: "send0-d1",
        starts: [[{ op: "Configure", preset: "send0" }]],
        maxDepth: 1,
        maxStates: 200,
      },
      {
        name: "upload0-d2",
        starts: [[{ op: "Configure", preset: "upload0" }]],
        maxDepth: 2,
        maxStates: 200,
      },
    ],
  },
  inbox: {
    model: inbox,
    profiles: [
      {
        name: "core-d2",
        starts: [[{ op: "Configure", preset: "core" }]],
        maxDepth: 2,
        maxStates: 350,
      },
    ],
  },
  "campaign-lifecycle": {
    model: campaignLifecycle,
    profiles: [
      {
        name: "small-d2",
        starts: [[{ op: "Configure", preset: "small" }]],
        maxDepth: 2,
        maxStates: 120,
        filter: (a) => !["Tick", "SetQuota", "InjectFeedbackLag"].includes(a.op),
      },
    ],
  },
  billing: {
    model: billing,
    profiles: [
      {
        name: "funded-d2",
        starts: [[{ op: "Configure", preset: "funded" }]],
        maxDepth: 2,
        maxStates: 120,
        filter: (a) => {
          if (a.op === "Wait") return a.seconds === 360;
          if (a.op === "SendUsage") return a.amountCents === 1000;
          if (a.op === "TopUp") return a.amountCents !== 5000 && a.outcome !== "stripe_5xx";
          if (a.op === "ReconcileAttempt") return a.target === "latest" && (a.stripeState === "paid" || a.stripeState === "void");
          if (a.op === "Refund") return a.target === "latest" && a.amountCents === undefined;
          if (a.op === "DisputeCreated") return a.target === "latest" && a.partialCents === undefined;
          if (a.op === "WebhookInvoicePaid") return a.target === "latest" && a.mode !== "duplicate";
          if (a.op === "EarlyFraudWarning") return a.target === "latest";
          return true;
        },
      },
    ],
  },
  "byo-regional": {
    model: byoRegional,
    profiles: [
      {
        name: "ready-d2",
        starts: [
          [{ op: "Configure", preset: "readyToImport" }],
          [{ op: "Configure", preset: "hosted" }],
        ],
        maxDepth: 2,
        maxStates: 120,
        filter: (a) => !["SetRegionFault", "SetDisconnectFault"].includes(a.op),
      },
    ],
  },
  delivery: {
    model: delivery,
    profiles: [
      {
        name: "retries1-core-d2",
        starts: [[{ op: "Configure", preset: "retries1" }]],
        maxDepth: 2,
        maxStates: 120,
        filter: (a) => {
          if (a.op === "Ingest") return a.m === "m1" && a.variant === "plain" && a.rcpts.length === 1;
          if (a.op === "Reply") return ["200", "500", "429", "timeout"].includes(a.resp);
          if (a.op === "Rituals") return ["both", "none", "bad"].includes(a.set);
          if (a.op === "Rate") return false;
          return true;
        },
      },
    ],
  },
};

interface Edge {
  fromKey: string;
  toKey: string;
  action: unknown;
  actionKey: string;
  covered: boolean;
}

function generateProfileTraces(m: Model<any, any, any, any>, profile: EdgeProfile) {
  const prefixOf = new Map<string, unknown[]>();
  const outgoing = new Map<string, Edge[]>();
  const queue: { state: unknown; path: unknown[]; depth: number }[] = [];

  for (const start of profile.starts) {
    let s = m.initial();
    for (const a of start) s = m.step(s, a).next;
    const k = JSON.stringify(s);
    if (!prefixOf.has(k)) {
      prefixOf.set(k, start);
      queue.push({ state: s, path: start, depth: 0 });
    }
  }

  let totalEdges = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const fromKey = JSON.stringify(cur.state);
    if (cur.depth >= profile.maxDepth) continue;
    const list = outgoing.get(fromKey) ?? [];
    outgoing.set(fromKey, list);

    for (const ch of m.choices(cur.state)) {
      const a = ch.action;
      if (profile.filter && !profile.filter(a)) continue;
      const res = m.step(cur.state, a);
      if (res.mask) continue;
      const toKey = JSON.stringify(res.next);
      const actionKey = JSON.stringify(a);
      list.push({ fromKey, toKey, action: a, actionKey, covered: false });
      totalEdges += 1;
      if (!prefixOf.has(toKey) && prefixOf.size < profile.maxStates) {
        const nextPath = [...cur.path, a];
        prefixOf.set(toKey, nextPath);
        queue.push({ state: res.next, path: nextPath, depth: cur.depth + 1 });
      }
    }
  }

  // Greedy edge-chaining: start from the shortest prefix to any uncovered edge, then keep
  // stepping along uncovered edges up to maxChainLen so every discovered edge executes on the
  // real host in far fewer resets than 1 case per edge.
  const maxChainLen = Math.max(12, Math.min(28, (m.maxSteps ?? 24) - 2));
  const traces: unknown[][] = [];

  for (const [stateKey, edges] of outgoing.entries()) {
    for (const edge of edges) {
      if (edge.covered) continue;
      const trace = [...prefixOf.get(stateKey)!, edge.action];
      edge.covered = true;
      let curKey = edge.toKey;
      while (trace.length < maxChainLen) {
        const nextList = outgoing.get(curKey);
        const nextEdge = nextList?.find((e) => !e.covered);
        if (!nextEdge) break;
        nextEdge.covered = true;
        trace.push(nextEdge.action);
        curKey = nextEdge.toKey;
      }
      traces.push(trace);
    }
  }

  return { states: prefixOf.size, totalEdges, traces };
}

const [checker, outFile] = process.argv.slice(2);
if (!checker || !outFile || !(checker in MODELS)) {
  console.error("usage: bun edges.ts <dispatch|ses|access|admission|inbox|delivery|campaign-lifecycle|billing|byo-regional> <out.json>");
  process.exit(2);
}

const entry = MODELS[checker]!;
const cases: any[] = [];
let totalStates = 0;
let totalEdges = 0;

for (const profile of entry.profiles) {
  const res = generateProfileTraces(entry.model, profile);
  totalStates += res.states;
  totalEdges += res.totalEdges;
  res.traces.forEach((steps, idx) => {
    cases.push({
      name: `edge-${profile.name}-${String(idx + 1).padStart(4, "0")}`,
      steps,
      expected: { outcome: "pass" },
      note: `Exhaustive BFS edge cover (${profile.name})`,
    });
  });
}

// Mark case 0 as control so tear test campaign satisfies control presence.
if (cases.length > 0) {
  cases[0].expected.control = true;
}

writeFileSync(
  outFile,
  JSON.stringify({ version: 1, modelId: checker, cases }, null, 2) + "\n",
);
console.log(
  `edges(${checker}): ${totalEdges} BFS edges across ${totalStates} states packed into ${cases.length} traces -> ${outFile}`,
);
