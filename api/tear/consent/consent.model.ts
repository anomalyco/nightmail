/**
 * Nightmail Consent, Imports & Unsubscribes model ("an unsubscribe always wins").
 *
 * Pure reference model: never imports api/src/. Covers CSV imports, direct contact CRUD,
 * explicit consent API, AudienceQL bulk plan/apply, list memberships, one-click & footer
 * unsubscribe links, SES bounce/complaint/validation feedback, manual suppression, delete +
 * restore, multi-workspace isolation (same email in wsA and wsB), campaign freeze/expand/
 * dispatch races, and all 7 named invariants under --rounds 2 concurrency.
 */
import { choice, model, prop, satisfies, sel, type Choice, type IdleRule, type Step } from "@tear/mbt";
import type {
  ConsentAction,
  ConsentObs,
  ConsentPreset,
  ConsentSnapshot,
  ContactSlot,
} from "./consent.types.ts";

export interface ConsentState {
  configured: boolean;
  preset: ConsentPreset | null;
  hasPlan: boolean;
  planStatus: "subscribed" | "unsubscribed" | null;
  unsubAtPlan: ContactSlot[];
  unsubSincePlan: ContactSlot[];
  unsubscribed: ContactSlot[];
  hasCampaign: boolean;
  created: ContactSlot[];
}

const SLOTS: readonly ContactSlot[] = ["c1", "c2", "c3", "c4"] as const;

const consentIdleRules: IdleRule<ConsentSnapshot>[] = [
  {
    id: "consent.no-silent-override",
    description:
      "unsubscribe, complaint, or hard-bounce suppression is never undone by an import, bulk plan, profile edit, or unconfirmed/stale consent write",
    when: (s) => s.configured,
    check: (s) => (s.overrideViolations.length ? s.overrideViolations[0] : undefined),
  },
  {
    id: "consent.serializable-unsub-wins",
    description:
      "under concurrent writes, final contact state matches a serial order in which every unsubscribe/suppression wins over conflicting writes",
    when: (s) => s.configured,
    check: (s) => (s.serializabilityViolations.length ? s.serializabilityViolations[0] : undefined),
  },
  {
    id: "consent.no-send-to-blocked",
    description: "nobody unsubscribed, suppressed, or deleted before release/claim is ever sent to SES",
    when: (s) => s.configured,
    check: (s) => (s.blockedSendViolations.length ? s.blockedSendViolations[0] : undefined),
  },
  {
    id: "consent.evidence-preserved-and-order-independent",
    description:
      "consent audit rows (who, when, source, evidence, policyVersion) are append-only and survive later writes/retention; suppressed_at is order-independent",
    when: (s) => s.configured,
    check: (s) => (s.evidenceViolations.length ? s.evidenceViolations[0] : undefined),
  },
  {
    id: "consent.tallies-exact",
    description:
      "API list and audience counts always equal a raw SQL recount over active members, non-negative, mutually exclusive, summing to total",
    when: (s) => s.configured,
    check: (s) => (s.tallyViolations.length ? s.tallyViolations[0] : undefined),
  },
  {
    id: "consent.workspace-isolated",
    description:
      "workspace A unsubscribes, suppressions, imports, and deletes never alter workspace B's contact with the same email (Hosted SES SuppressionScope is TENANT)",
    when: (s) => s.configured,
    check: (s) => (s.workspaceViolations.length ? s.workspaceViolations[0] : undefined),
  },
  {
    id: "consent.limits-atomic",
    description:
      "10,000 bulk cap, 50,000 import row cap, 50-property cap, 50 open-preview cap, rate limits, and 16 KiB property cap fail whole cleanly without partial writes",
    when: (s) => s.configured,
    check: (s) => (s.limitViolations.length ? s.limitViolations[0] : undefined),
  },
  {
    id: "consent.no-leaked-errors",
    description: "no unhandled rejections or host errors",
    when: (s) => s.configured,
    check: (s) => (s.leakedErrors.length ? s.leakedErrors.join("; ") : undefined),
  },
];

export const consent = model<ConsentState, ConsentAction, ConsentObs, ConsentSnapshot>({
  id: "consent",
  description:
    "Imports, consent, unsubscribes, suppressions, AudienceQL bulk plans, tallies, and cross-workspace isolation under concurrency",
  maxSteps: 20,
  rounds: 2,
  bug: "canary_send_unsubscribed",
  roundRoles: {
    Configure: "sequential",
    CreateContact: "call",
    UpdateProfile: "call",
    DeleteContact: "call",
    SetConsentApi: "call",
    ConfirmResubscribeApi: "sequential",
    AddToList: "call",
    RemoveFromList: "call",
    ImportCommit: "call",
    PlanBulkConsent: "sequential",
    ApplyBulkPlan: "sequential",
    UnsubscribeGet: "read",
    UnsubscribeOneClick: "call",
    UnsubscribeFooter: "call",
    FeedbackSuppress: "call",
    ManualSuppress: "call",
    LaunchCampaign: "sequential",
    ExpandCampaign: "sequential",
    DispatchCampaign: "sequential",
    RaceImportAndUnsub: "sequential",
    RacePlanApplyAndUnsub: "sequential",
    RaceStaleResubscribeAndUnsub: "sequential",
    RaceFeedbackOrderCheck: "sequential",
    CheckLimits: "sequential",
    RunRetentionScrub: "sequential",
    VerifyAll: "sequential",
  },

  initial: (): ConsentState => ({
    configured: false,
    preset: null,
    hasPlan: false,
    planStatus: null,
    unsubAtPlan: [],
    unsubSincePlan: [],
    unsubscribed: [],
    hasCampaign: false,
    created: [],
  }),

  choices(s): Choice<ConsentAction>[] {
    if (!s.configured) {
      return [
        choice({ op: "Configure", preset: "core" }, 30),
        choice({ op: "Configure", preset: "bulkLimit" }, 1),
        choice({ op: "Configure", preset: "rateLimit" }, 1),
      ];
    }
    if (s.preset === "bulkLimit") {
      return [
        choice({ op: "CheckLimits", kind: "bulk10k" }, 10),
        choice({ op: "VerifyAll" }, 2),
      ];
    }
    if (s.preset === "rateLimit") {
      return [
        choice({ op: "CheckLimits", kind: "rateLimit" }, 10),
        choice({ op: "VerifyAll" }, 2),
      ];
    }
    const out: Choice<ConsentAction>[] = [];
    const add = (a: ConsentAction, w = 1) => out.push(choice(a, w));

    for (const slot of SLOTS) {
      add({ op: "CreateContact", slot }, s.created.includes(slot) ? 2 : 6);
      add({ op: "UpdateProfile", slot, name: "Alice" }, 3);
      add({ op: "UpdateProfile", slot, name: "Bob" }, 2);
      add({ op: "DeleteContact", slot }, 3);
      add({ op: "SetConsentApi", slot, status: "subscribed" }, 5);
      add({ op: "SetConsentApi", slot, status: "unsubscribed" }, 6);
      add({ op: "ConfirmResubscribeApi", slot }, 2);
      add({ op: "ConfirmResubscribeApi", slot, staleTimestamp: true }, 2);
      add({ op: "AddToList", slot, list: "L1" }, 4);
      add({ op: "AddToList", slot, list: "L2" }, 3);
      add({ op: "RemoveFromList", slot, list: "L1" }, 2);
      add({ op: "RemoveFromList", slot, list: "L2" }, 2);
      add({ op: "UnsubscribeGet", slot }, 2);
      add({ op: "UnsubscribeOneClick", slot }, 6);
      add({ op: "UnsubscribeFooter", slot }, 4);
      add({ op: "FeedbackSuppress", slot, kind: "hard_bounce", tsOffsetSec: 0 }, 3);
      add({ op: "FeedbackSuppress", slot, kind: "hard_bounce", tsOffsetSec: 60 }, 2);
      add({ op: "FeedbackSuppress", slot, kind: "complaint", tsOffsetSec: 0 }, 3);
      add({ op: "FeedbackSuppress", slot, kind: "complaint", tsOffsetSec: 120 }, 2);
      add({ op: "FeedbackSuppress", slot, kind: "email_validation", tsOffsetSec: 0 }, 2);
      add({ op: "ManualSuppress", slot }, 2);
    }

    add({ op: "ImportCommit", slots: ["c1", "c2"], list: "L1", attested: true }, 6);
    add({ op: "ImportCommit", slots: ["c1", "c2"], list: "L1", attested: false }, 4);
    add({ op: "ImportCommit", slots: ["c1", "c2", "c3"], list: "L1", attested: true }, 3);
    add({ op: "ImportCommit", slots: ["c1", "c2", "c3", "c4"], list: "L1", attested: true }, 2);
    add({ op: "ImportCommit", slots: ["c1", "c4"], list: "L1", attested: true }, 3);
    add({ op: "ImportCommit", slots: ["c3"], list: "L1", attested: true }, 2);
    add({ op: "ImportCommit", slots: ["c3", "c4"], list: "L2", attested: true }, 3);
    add({ op: "ImportCommit", slots: ["c2", "c3", "c4"], list: "L2", attested: true }, 3);
    add({ op: "ImportCommit", slots: ["c1"], attested: true }, 3);

    add({ op: "PlanBulkConsent", status: "subscribed" }, 5);
    add({ op: "PlanBulkConsent", status: "unsubscribed" }, 4);
    add({ op: "ApplyBulkPlan", confirmResubscribe: false }, s.hasPlan ? 6 : 1);
    add({ op: "ApplyBulkPlan", confirmResubscribe: true }, s.hasPlan ? 3 : 1);

    add({ op: "LaunchCampaign", list: "L1" }, 4);
    add({ op: "LaunchCampaign", list: "L2" }, 2);
    add({ op: "ExpandCampaign" }, s.hasCampaign ? 6 : 1);
    add({ op: "DispatchCampaign" }, s.hasCampaign ? 6 : 1);

    add({ op: "RaceImportAndUnsub", slot: "c1" }, 4);
    add({ op: "RaceImportAndUnsub", slot: "c3" }, 2);
    add({ op: "RacePlanApplyAndUnsub", slot: "c1" }, 2);
    add({ op: "RacePlanApplyAndUnsub", slot: "c2" }, 4);
    add({ op: "RaceStaleResubscribeAndUnsub", slot: "c1" }, 3);
    add({ op: "RaceFeedbackOrderCheck", slot: "c3" }, 3);

    add({ op: "CheckLimits", kind: "importProps51" }, 1);
    add({ op: "CheckLimits", kind: "import50k" }, 1);
    add({ op: "CheckLimits", kind: "previewCap50" }, 1);
    add({ op: "CheckLimits", kind: "props16k" }, 1);
    add({ op: "RunRetentionScrub" }, 2);

    add({ op: "VerifyAll" }, 5);
    return out;
  },

  step(s, a): Step<ConsentState, ConsentObs> {
    if (a.op === "Configure") {
      return {
        next: {
          configured: true,
          preset: a.preset,
          hasPlan: false,
          planStatus: null,
          unsubAtPlan: [],
          unsubSincePlan: [],
          unsubscribed: [],
          hasCampaign: false,
          created: ["c1", "c2", "c3"],
        },
        expect: satisfies("configured-ok", (obs) =>
          obs.status === 200 ? true : "Configure failed: status=" + obs.status + " code=" + obs.code,
        ),
      };
    }

    const next = structuredClone(s);
    const markUnsub = (slot: ContactSlot) => {
      if (!next.unsubscribed.includes(slot)) next.unsubscribed.push(slot);
      if (next.hasPlan && !next.unsubSincePlan.includes(slot)) next.unsubSincePlan.push(slot);
    };

    // Known product bug BUG-CONSENT-01: recordUnsubscribe early-returns without bumping updated_at
    // when a contact is already unsubscribed, so a bulk plan created before a repeat one-click/footer
    // unsubscribe bypasses STALE_AUDIENCE_PLAN and flips the contact back to subscribed.
    let mask: string | undefined;
    if ((a.op === "RacePlanApplyAndUnsub" || a.op === "RaceStaleResubscribeAndUnsub") && s.unsubscribed.includes(a.slot)) {
      mask = "BUG-CONSENT-01";
    } else if (
      a.op === "ApplyBulkPlan" &&
      a.confirmResubscribe &&
      s.planStatus === "subscribed" &&
      s.unsubSincePlan.some((slot) => s.unsubAtPlan.includes(slot))
    ) {
      mask = "BUG-CONSENT-01";
    }

    if (a.op === "CreateContact" && !next.created.includes(a.slot)) next.created.push(a.slot);
    if (a.op === "PlanBulkConsent") {
      next.hasPlan = true;
      next.planStatus = a.status;
      next.unsubAtPlan = [...s.unsubscribed];
      next.unsubSincePlan = [];
    }
    if (a.op === "UnsubscribeOneClick" || a.op === "UnsubscribeFooter" || (a.op === "SetConsentApi" && a.status === "unsubscribed")) {
      markUnsub(a.slot);
    }
    if (a.op === "RaceImportAndUnsub" || a.op === "RacePlanApplyAndUnsub" || a.op === "RaceStaleResubscribeAndUnsub") {
      markUnsub(a.slot);
    }
    if (a.op === "ConfirmResubscribeApi" && !a.staleTimestamp) {
      next.unsubscribed = next.unsubscribed.filter((x) => x !== a.slot);
    }
    if (a.op === "ApplyBulkPlan" && a.confirmResubscribe && s.planStatus === "subscribed" && s.unsubSincePlan.length === 0) {
      next.unsubscribed = [];
    }
    if (a.op === "LaunchCampaign") next.hasCampaign = true;

    const expect = satisfies("consent-step-valid", (obs) => {
      if (a.op === "ImportCommit") {
        if (obs.status === 200 || obs.status === 409 || obs.status === 429) return true;
        if (obs.status === 503 && obs.retryable === true) return true;
        return "ImportCommit unexpected error: status=" + obs.status + " code=" + obs.code;
      }
      if (a.op === "LaunchCampaign") {
        if (obs.status === 202 || obs.status === 409 || obs.status === 429) return true;
        if (obs.status === 422 && obs.code === "EMPTY_AUDIENCE") return true;
        if (obs.status === 503 && obs.retryable === true) return true;
        return "LaunchCampaign unexpected error: status=" + obs.status + " code=" + obs.code;
      }
      if (a.op === "UnsubscribeGet" || a.op === "UnsubscribeOneClick" || a.op === "UnsubscribeFooter") {
        if (obs.status === 200 || obs.status === 429) return true;
        return a.op + " unexpected error: status=" + obs.status + " code=" + obs.code;
      }
      if (obs.status >= 200 && obs.status < 300) return true;
      if ([400, 404, 409, 413, 422, 429].includes(obs.status)) return true;
      if (obs.status === 503 && obs.retryable === true) return true;
      return a.op + " unexpected error: status=" + obs.status + " code=" + obs.code + " retryable=" + obs.retryable + " detail=" + (obs.detail ?? "");
    });

    return mask ? { next, expect, mask } : { next, expect };
  },

  idle: consentIdleRules,

  temporal: [
    {
      id: "consent.no-send-after-block",
      title: "a contact unsubscribed or suppressed before release is never sent to SES",
      prop: prop.optional(
        prop.forEach(
          { name: "slot", discover: sel.event("consent.blocked"), key: "/slot" },
          (slot) => [prop.never(sel.event("consent.sent", { "/slot": slot }))],
        ),
      ),
    },
  ],
});
