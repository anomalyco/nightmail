// Changes to the legal pages that are announced before they take effect (Privacy Policy section 14: customers are told at
// least 30 days before a material change). Each names the UTC day it was announced and the instant it takes effect, a
// midnight UTC. It imports nothing, so the dashboard's build and the API both read it.
// - The legal pages (app/legal-markdown.ts) carry each change's wording for before and after `from`, and date themselves
//   by it: updated on `announced`, then updated and effective on `from`. A page built before `from` says both, which
//   stays true after it; the first build after `from` keeps only the later wording. The build refuses a `from` less than
//   31 days after `announced` (30 days' notice, and a day for the change to reach customers after it merges).
// - The dashboard shows the notice from `announced` until `from` (app/src/components/PolicyBanner.tsx).
// - api/scripts/check-premerge.ts refuses a new or edited `announced` that isn't the day the check runs (UTC), so the date
//   the pages give and the 31 days count from the day the change merges. A change that lets us do more than what was
//   announced needs a new `announced` day, and so a new 31 days.
//
// abuseHolds: holds for review (Privacy Policy section 5.7). The code that holds sending reads `from` and holds nothing
// automatically before it, whatever its own setting says.
export const POLICY_CHANGES = {
  abuseHolds: { announced: '2026-11-27', from: '2027-01-04T00:00:00Z' },
} as const satisfies Record<string, { announced: string; from: string }>;

export type PolicyChange = keyof typeof POLICY_CHANGES;
export const isPolicyChange = (name: string): name is PolicyChange => Object.hasOwn(POLICY_CHANGES, name);

/** Whether a change has taken effect. */
export const policyInEffect = (change: PolicyChange, now = Date.now()) => now >= Date.parse(POLICY_CHANGES[change].from);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** A day as the legal pages write it ("4 January 2027"), in UTC. */
export function policyDay(iso: string): string {
  const day = new Date(iso);
  return `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
}
