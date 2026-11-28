import { sql, type SQL } from 'drizzle-orm';
import { ApiError } from './core/errors.js';
import type { Config } from './core/types.js';
import { productName } from './brand.js';

// Simulator feedback is not reputation evidence. Admission and dispatch,
// however, consume capacity for every destination, including the simulator.
const simulatorSuffix = '@simulator.amazonses.com';
export const realDestination = (address: string) => !address.toLowerCase().endsWith(simulatorSuffix);
export const hostedCost = (to: string | string[], cc: string[] = [], bcc: string[] = []) =>
  (Array.isArray(to) ? to.length : 1) + cc.length + bcc.length;

export type HostedAllowance = ({ cap: number; marketingCap: number } | { cap: null; marketingCap: null }) & { used: number; resetAt: string | null; nextChangeAt: string; pauseReason: string | null; pendingCapOverride: number | null; exemptHostedQuotas: boolean; nextCap?: number | null; nextCapAt?: string | null; marketingHeld?: boolean; marketingHoldReason?: string | null; step?: string; marketingHourCap?: number | null; marketingHourUsed?: number; marketingHourResetAt?: string | null; marketingDayCap?: number | null };
// The current UTC hour plus the preceding 23 buckets. The same statement as admission,
// independent of how many envelopes or destinations were admitted in those hours.
// `read` is for display (GET /v1/me): the same figures from hosted_allowance_read, which takes no row locks.
// Admission keeps hosted_allowance, which locks the policy rows FOR SHARE against a concurrent pause or cap change.
export function hostedAllowance(config: Config, wid: string, incoming: number, marketing = 0, read = false) {
  if (!config.multiTenant) return sql<HostedAllowance | null>`NULL`;
  // The two NULLs are the retired second-week and mature caps, which the functions no longer read.
  const fn = read ? sql`hosted_allowance_read` : sql`hosted_allowance`;
  return sql<HostedAllowance | null>`(SELECT allowance FROM ${fn}(${wid},${incoming},${marketing},${config.hostedSendCaps.firstWeek},NULL,NULL,${config.dispatch.dailyHeadroomPercent}))`;
}
/**
 * Why a Hosted workspace is still on probation, as an expression over its stored standing (src/standing.ts):
 * 'evaluation' until its first grade (no standing yet included), 'growth' during the growth pace after it, 'standing'
 * while the score, a freeze or a strike sets a daily limit or a ladder step from warn up applies; NULL in good standing.
 * Probation keeps the checks for new senders: the delivered HTML is the copy the screen read, with the image and
 * attachment rules (src/screened-html.ts), and a campaign's list probe. Senders leave it by themselves on good standing.
 */
export type ProbationReason = 'evaluation' | 'growth' | 'standing';
export const probationReason = (wid: SQL) => sql<ProbationReason | null>`nullif(coalesce((SELECT CASE WHEN s.phase<>'graded' THEN 'evaluation'
  WHEN s.growth_until>now() THEN 'growth' WHEN s.daily_limit IS NOT NULL OR s.step NOT IN ('ok','notice') THEN 'standing' ELSE '' END
  FROM sender_standing s WHERE s.workspace_id=${wid}),'evaluation'),'')`;
/**
 * The stream a marketing hold stops, as an expression over a sending_emails row: marketing mail and every campaign
 * row. Admission, campaign release and dispatch (owner selection and the final election) use the same rule.
 */
export const heldStream = (e: SQL) => sql`(${e}.snapshot->>'kind'<>'transactional' OR ${e}.campaign_id IS NOT NULL OR ${e}.snapshot ? 'bulk')`;
/**
 * Server-side evidence that a message is bulk, whatever kind its caller chose: at least 10 real recipients, list
 * headers (List-Id and the other List-* headers, Precedence: bulk/list/junk), or one of at least 10 identical
 * messages (subject, body and template) in one request. Bulk mail is marketing for holds, the transactional reserve,
 * the dispatch fence and reputation attribution (snapshot.bulk); it keeps its stream, configuration set and content.
 */
export const BULK = { recipients: 10, copies: 10 } as const;
/**
 * A campaign test is the campaign's copy sent as transactional mail, outside its audience's consent, the marketing ramp,
 * holds and pacing, and the campaign's own screening. On Hosted sending one goes only to an address the workspace has
 * proven is its own (a member's verified email, an address at one of its currently verified domains or their subdomains, which
 * holds its receiving addresses and inboxes there, or the SES mailbox simulator), and a workspace sends at most
 * `perHour` in a clock hour. Anyone else gets the campaign itself.
 */
export const CAMPAIGN_TESTS = { perHour: 20 } as const;
const LIST_HEADER = /^list-(?:id|unsubscribe|unsubscribe-post|help|subscribe|post|owner|archive)$/i;
type BulkInput = { kind?: string; to: string | string[]; cc?: string[]; bcc?: string[]; subject?: string; html?: string; text?: string; template?: unknown; headers?: { name: string; value: string }[] };
export function bulkFlags(mails: BulkInput[]) {
  const content = (m: BulkInput) => JSON.stringify([m.subject ?? null, m.html ?? null, m.text ?? null, m.template ?? null]), copies = new Map<string, number>();
  for (const m of mails) copies.set(content(m), (copies.get(content(m)) ?? 0) + 1);
  return mails.map(m => m.kind !== 'marketing' && (
    [...(Array.isArray(m.to) ? m.to : [m.to]), ...(m.cc ?? []), ...(m.bcc ?? [])].filter(realDestination).length >= BULK.recipients
    || !!m.headers?.some(h => LIST_HEADER.test(h.name) || (h.name.toLowerCase() === 'precedence' && /^(?:bulk|list|junk)$/i.test(h.value.trim())))
    || copies.get(content(m))! >= BULK.copies));
}
/**
 * Restrict, an operator's hold, or a marketing hold placed before the standing took over (bounces only): marketing is
 * refused while transactional mail keeps flowing. `reason` is that older hold's own message.
 */
export const marketingHeld = (reason?: string | null) => new ApiError(409, 'MARKETING_HELD', reason ? `${reason} Remove the addresses that bounced; ${productName} reviews the hold.`
  : 'Marketing from this workspace is held while its sending standing is restricted: bounces or complaints crossed a published line (see GET /v1/sender-score). Transactional mail still sends. Fix the list, then release it from the dashboard or ask for a review.');
