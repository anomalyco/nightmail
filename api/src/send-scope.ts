import { sql, type SQL } from 'drizzle-orm';
import { ApiError, notFound, type DbExecutor } from './core.js';

declare const held: unique symbol, unlocked: unique symbol;
/**
 * Proof that this transaction holds a workspace's send locks, taken in the one order every path that sends, launches
 * a campaign or changes a sending connection uses: the campaign row (when one is named), then the admission row
 * (job_schedule), then the settings row; sender claims and attachments only after them. Only lockSendScope makes one,
 * and what reads settings or sender claims in those paths takes one, so the type checker holds the order. Two paths that took them in other orders deadlocked (dev, Nov 12; launch against a BYO disconnect).
 * A send admitted in one statement takes the same locks, in the same order, inside the admission decision
 * (send_admission with locks 'take', migration 323); every other admission is given the SendScope its caller holds.
 */
export type SendScope = { readonly [held]: true; readonly workspaceId: string };
/**
 * A sender-claim read in a transaction that holds no admission or settings lock and takes none after it (dispatch, a
 * campaign's prepare step, a check outside a transaction): its claim locks come last there, so they close no cycle.
 */
export type ClaimsOnly = { readonly [unlocked]: true };
export const claimsOnly = {} as ClaimsOnly;
const scope = (workspaceId: string) => ({ workspaceId }) as SendScope;

// A workspace row lock serializes admission without Hyperdrive-unsupported advisory locks. It reuses the scheduler
// row without changing its rotation counter: ON CONFLICT locks the existing tuple even when its UPDATE predicate is
// false, so no dead tuple per send.
const admission = (workspaceId: string, from?: SQL) => sql`INSERT INTO job_schedule (workspace_id) SELECT ${workspaceId}::text ${from ?? sql``}
  ON CONFLICT (workspace_id) DO UPDATE SET turn = job_schedule.turn WHERE false`;

/**
 * Takes a workspace's send locks in order: the campaign row, the admission row, then (when asked) the settings row.
 * Paths that read settings with their sender claims in one statement lock it there instead (lockedSettings).
 * The admission row holds off every send in the workspace, so a transaction that takes it makes no network call.
 * Connection work that calls AWS while it holds the settings row locks that row alone (getRegionSettings(db, wid,
 * 'update')): it never waits for admission, so it stays a compatible subset of this order.
 */
export async function lockSendScope(db: DbExecutor, workspaceId: string, options: { campaignId?: string; settings?: 'share' | 'update' } = {}): Promise<SendScope> {
  // The admission insert reads the locked campaign row, so one statement takes them in order.
  if (options.campaignId && !(await db.execute(sql`WITH campaign AS MATERIALIZED (SELECT FROM sending_campaigns WHERE workspace_id=${workspaceId} AND id=${options.campaignId} FOR UPDATE),
    locked AS (${admission(workspaceId, sql`FROM campaign`)}) SELECT FROM campaign`)).rowCount) notFound('Campaign');
  if (!options.campaignId) await db.execute(admission(workspaceId));
  if (options.settings && !(await db.execute(sql`SELECT FROM ses_installation_settings WHERE workspace_id=${workspaceId} ${options.settings === 'update' ? sql`FOR UPDATE` : sql`FOR SHARE`}`)).rowCount)
    throw new ApiError(503, 'REGION_SETTINGS_NOT_INITIALIZED', 'Run database migrations to initialize SES region settings.');
  return scope(workspaceId);
}
