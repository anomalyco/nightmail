import { sql } from 'drizzle-orm';
import { isSimulatedSes } from '../core/ses.js';
import { log } from '../log.js';
import type { JobHandler } from '../core/types.js';
import { retryDatabaseFailures } from '../jobs.js';
import { deliverNotice, heldNotice, noticeFailed, noticeRecipients } from '../account-notices.js';
import { customerNotice, type Notice, type NoticeInput } from '../notices.js';
import { formatUsd, microCents, RATES, type MicroCents } from './money.js';
import type { NoticeKind } from './types.js';

// Owner emails about money (job billing.notify, one per billing_notices row). The notice row is the dedupe: A's
// billing_notice() inserts it once per episode (its dedupe_key is unique) with this job. Here a 5-minute lease
// makes one runner send it, the idempotency key makes a retried send one email, and the status ends sent,
// suppressed (shadow mode, or the account is not prepaid) or failed (nobody to tell, or every attempt to send failed:
// a send that fails gives its lease back and is retried, account-notices.ts). src/notices.ts writes each email:
// what happened, what it means for mail now and what to do, with the Billing link.

export type NoticeContext = {
  workspace: string;
  /** The dashboard's origin (PUBLIC_URL). */
  origin: string;
  /** Paid + promotional credit, after settlement. */
  totalUc: MicroCents;
  /** Free sends left this month, from billing_position. */
  freeLeft: number;
  unpaidSince: Date | null;
  /** Receive holds are on (billing_config.receive_hold); unset means on. */
  receiveHold?: boolean;
  data: Record<string, unknown>;
};

const DAY = 86_400_000;
// Stripe decline codes in plain words. Anything else falls back to Stripe's own message.
const DECLINES: Record<string, string> = {
  card_declined: 'the bank declined it', generic_decline: 'the bank declined it', do_not_honor: 'the bank declined it', lost_card: 'the bank declined it', stolen_card: 'the bank declined it',
  insufficient_funds: 'the card has insufficient funds', expired_card: 'the card has expired', incorrect_cvc: 'the card’s security code was wrong',
  authentication_required: 'the bank asked for confirmation (3-D Secure), which needs you present', processing_error: 'the card processor had an error',
  card_velocity_exceeded: 'the card reached its spending limit', withdrawal_count_limit_exceeded: 'the card reached its spending limit',
  customer_tax_location_invalid: 'Stripe could not determine the tax location from the address on file',
};
export const declineWords = (code: unknown, message: unknown) => (typeof code === 'string' && DECLINES[code]) || (typeof message === 'string' && message.trim() ? message.trim().replace(/\.$/, '') : 'the bank declined it');

/** The email for one billing notice. Pure: the acceptance tests and the job share it. */
export function noticeEmail(kind: NoticeKind, n: NoticeContext): Notice {
  const workspace = n.workspace, total = formatUsd(n.totalUc), owed = formatUsd(microCents(n.totalUc < 0n ? -n.totalUc : 0n));
  const holdAt = n.unpaidSince && n.receiveHold !== false ? new Date(n.unpaidSince.getTime() + 7 * DAY) : null;
  const input = ((): NoticeInput => {
    switch (kind) {
      case 'low_balance': return { kind, workspace, balance: total, emails: Number((n.totalUc > 0n ? n.totalUc / RATES.emailUc : 0n) + BigInt(Math.max(0, n.freeLeft))) };
      case 'sends_paused': return { kind: 'out_of_credit', workspace, receivingUntil: holdAt };
      case 'recharge_failed': return { kind, workspace, last4: typeof n.data.last4 === 'string' && /^\d{4}$/.test(n.data.last4) ? n.data.last4 : null, decline: declineWords(n.data.code, n.data.message), taxLocation: n.data.code === 'customer_tax_location_invalid', balance: total };
      case 'receive_hold_soon': return { kind, workspace, owed, since: n.unpaidSince, holdAt: n.unpaidSince && new Date(n.unpaidSince.getTime() + 7 * DAY) };
      case 'receive_held': return { kind, workspace, owed, since: n.unpaidSince };
      case 'credit_expiring': return { kind, workspace, amount: formatUsd(microCents(typeof n.data.remainingUc === 'string' ? n.data.remainingUc : '0')), expiresAt: typeof n.data.expiresAt === 'string' ? new Date(n.data.expiresAt) : null };
    }
  })();
  return customerNotice(n.origin, input);
}

type Row = { id: string; kind: NoticeKind; data: Record<string, unknown>; enforcement: string; receive_hold: boolean; mode: string; name: string | null; position: { availableUc?: string; balanceUc?: string; promoUc?: string; freeSentLeft?: number } | null; unpaid_since: Date | string | null; recipients: string[] };

export const notifyJob: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  const noticeId = typeof payload.noticeId === 'string' ? payload.noticeId : '';
  // The lease: one runner at a time, and a crashed send is retried after 5 minutes. Everything the email needs comes
  // back with it: the enforcement, the account's mode and position, and up to 20 owners and admins with a verified address.
  const { rows: [notice] } = await runtime.db.execute<Row>(sql`WITH leased AS (
      UPDATE billing_notices SET status='sending',lease_until=now()+interval '5 minutes'
      WHERE id=${noticeId} AND workspace_id=${job.workspaceId} AND (status='pending' OR (status='sending' AND lease_until<now())) RETURNING id,kind,data,workspace_id)
    SELECT l.id,l.kind,l.data,c.mode AS enforcement,c.receive_hold,coalesce(a.mode,'prepaid') AS mode,a.unpaid_since,w.name,billing_position(l.workspace_id) AS position,
      ${noticeRecipients(sql`l.workspace_id`)} AS recipients
    FROM leased l CROSS JOIN billing_config c LEFT JOIN billing_accounts a ON a.workspace_id=l.workspace_id LEFT JOIN workspaces w ON w.id=l.workspace_id WHERE c.singleton`);
  if (!notice) return heldNotice(runtime.db, 'billing_notices', noticeId);
  const settle = (status: 'sent' | 'suppressed' | 'failed') => runtime.db.execute(sql`UPDATE billing_notices SET status=${status},lease_until=NULL,sent_at=CASE WHEN ${status}='sent' THEN now() END
    WHERE id=${notice.id} AND status='sending'`);
  if (!runtime.config.multiTenant || notice.enforcement !== 'enforce' || notice.mode !== 'prepaid') {
    await settle('suppressed');
    log('info', { code: 'BILLING_NOTICE_SUPPRESSED', workspaceId: job.workspaceId, kind: notice.kind, enforcement: notice.enforcement, mode: notice.mode });
    return;
  }
  try {
    if (!notice.recipients.length) { await settle('failed'); log('warn', { code: 'BILLING_NOTIFY_NO_RECIPIENTS', workspaceId: job.workspaceId, kind: notice.kind }); return; }
    const position = notice.position ?? {};
    const totalUc = microCents(BigInt(position.balanceUc ?? '0') + BigInt(position.promoUc ?? '0'));
    const email = noticeEmail(notice.kind, { workspace: notice.name ?? '', origin: runtime.config.publicUrl, totalUc,
      freeLeft: Number(position.freeSentLeft ?? 0), unpaidSince: notice.unpaid_since ? new Date(notice.unpaid_since) : null, receiveHold: notice.receive_hold, data: notice.data ?? {} });
    if (await deliverNotice(runtime, notice.recipients, email, { billingNotice: notice.id }) === 'unconfigured') {
      await settle('failed');
      log('info', { code: 'BILLING_NOTIFY_SKIPPED', workspaceId: job.workspaceId, kind: notice.kind, reason: 'NIGHTMAIL_NOTIFY_FROM or the platform workspace is not configured' });
      return;
    }
    await settle('sent');
    log('info', { code: 'BILLING_NOTIFIED', workspaceId: job.workspaceId, kind: notice.kind, recipients: notice.recipients.length, simulated: isSimulatedSes(runtime) });
  } catch (error) { await noticeFailed(runtime, 'billing_notices', notice.id, job, error, notice.kind); throw error; }
});
