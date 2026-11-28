import { sql } from 'drizzle-orm';
import type { Database } from '../core.js';
import { CREDIT, perThousandUsd, rateUsd, RATES } from './rates.js';
import type { BillingPosition, BillingSummary } from './types.js';

export type BillingAccountRow = {
  position: BillingPosition; mode: string | null; low_balance_uc: string | null;
  recharge_enabled: boolean | null; recharge_threshold_uc: string | null; recharge_amount_uc: string | null; recharge_month_cap_uc: string | null;
  recharge_month: string | null; recharge_month_total_uc: string | null; recharge_pending_attempt: string | null; recharge_disabled_reason: string | null;
  card_brand: string | null; card_last4: string | null; card_exp_month: number | null; card_exp_year: number | null; aged_bytes: string | null;
};

export const billingAccountQuery = (workspaceId: string) => sql`SELECT billing_position(${workspaceId}) AS position, b.mode, b.low_balance_uc::text,
  b.recharge_enabled, b.recharge_threshold_uc::text, b.recharge_amount_uc::text, b.recharge_month_cap_uc::text, b.recharge_month::text, b.recharge_month_total_uc::text,
  b.recharge_pending_attempt, b.recharge_disabled_reason, b.card_brand, b.card_last4, b.card_exp_month, b.card_exp_year,
  (SELECT aged_bytes::text FROM mail_storage_aged WHERE workspace_id=${workspaceId}) AS aged_bytes
FROM (SELECT 1) one LEFT JOIN billing_accounts b ON b.workspace_id=${workspaceId}`;

type BillingView = { amounts: boolean; received: boolean; publicUrl?: string };

/**
 * The billing summary for one workspace, in one statement. `amounts` is false for members and read-only credentials:
 * balances, month-to-date cost and auto-recharge amounts are then null. `received` is false for credentials that may not
 * read every received message (as GET /v1/usage): the received allowance is then null. The topUpUrl is relative to
 * PUBLIC_URL and filled in by the route.
 */
export async function readBilling(db: Database, workspaceId: string, view: BillingView): Promise<BillingSummary> {
  const { rows: [row] } = await db.execute<BillingAccountRow>(billingAccountQuery(workspaceId));
  return billingSummary(row!, view);
}

export function billingSummary(row: BillingAccountRow, view: BillingView): BillingSummary {
  const p = row.position, now = new Date(), month = now.toISOString().slice(0, 7);
  const bal = BigInt(p.balanceUc), promo = BigInt(p.promoUc), open = BigInt(p.openUc), available = BigInt(p.availableUc);
  const enforced = p.enforcement === 'enforce' && p.mode === 'prepaid';
  const sending = enforced && (available < 0n || (available < RATES.emailUc && p.freeSentLeft === 0)) ? 'paused'
    : p.mode === 'prepaid' && bal + promo < BigInt(row.low_balance_uc ?? '500000000') ? 'low' : 'ok';
  // Grace counts down to a receive hold, so there is none while holds are off: received mail is then just accepted.
  const receiving = p.receiveHeld ? 'held' : p.unpaidSince && p.receiveHold ? 'grace' : 'ok';
  const thisMonth = `${month}-01`;
  const monthTotal = row.recharge_month === thisMonth ? BigInt(row.recharge_month_total_uc ?? '0') : 0n;
  const cap = BigInt(row.recharge_month_cap_uc ?? '50000000000'), amount = BigInt(row.recharge_amount_uc ?? '2500000000');
  const autoRecharge = !row.recharge_enabled ? (row.recharge_disabled_reason ? 'failed' : 'off') : row.recharge_pending_attempt ? 'pending' : monthTotal + amount > cap ? 'capped' : 'on';
  const sent = { limit: RATES.freeSentEmails, used: RATES.freeSentEmails - p.freeSentLeft, left: p.freeSentLeft };
  const day = 86_400_000, unpaid = p.unpaidSince ? Date.parse(p.unpaidSince) : null;
  const cents = (v: string | null, fallback: string) => Number(BigInt(v ?? fallback) / 1_000_000n);
  return {
    enforcement: p.enforcement, mode: p.mode,
    state: { sending, receiving, autoRecharge },
    balance: view.amounts ? { paid: bal.toString(), promo: promo.toString(), unsettled: open.toString(), available: available.toString() } : null,
    free: { month, emails: sent, sent, received: view.received ? { limit: RATES.freeReceivedEmails, used: RATES.freeReceivedEmails - p.freeReceivedLeft, left: p.freeReceivedLeft } : null, storage: { limitBytes: Number(RATES.freeStorageBytes), agedBytes: row.aged_bytes ?? '0' } },
    // This month's usage, settled or not, charged or not (a free workspace's usage is still measured), as before.
    monthToDate: view.amounts ? { cost: p.monthWouldBeUc } : null,
    grace: { unpaidSince: p.unpaidSince, receiveHoldAt: unpaid === null || !p.receiveHold ? null : new Date(unpaid + 7 * day).toISOString(), writeOffAt: unpaid === null ? null : new Date(unpaid + 60 * day).toISOString() },
    autoRecharge: view.amounts ? { enabled: !!row.recharge_enabled, thresholdCents: cents(row.recharge_threshold_uc, '1000000000'), amountCents: Number(amount / 1_000_000n), monthlyCapCents: Number(cap / 1_000_000n),
      monthTotalCents: Number(monthTotal / 1_000_000n), disabledReason: row.recharge_disabled_reason, pending: !!row.recharge_pending_attempt } : null,
    paymentMethod: view.amounts && row.card_last4 ? { brand: row.card_brand ?? 'card', last4: row.card_last4, expMonth: row.card_exp_month ?? 0, expYear: row.card_exp_year ?? 0 } : null,
    prices: { emailPerThousand: perThousandUsd(RATES.emailUc), decisionPerThousand: perThousandUsd(RATES.omenUc), omenPerThousand: perThousandUsd(RATES.omenUc), storagePerGbMonth: rateUsd(RATES.storageUcPerGbMonth), freeEmails: RATES.freeSentEmails, freeSentEmails: RATES.freeSentEmails, freeReceivedEmails: RATES.freeReceivedEmails, freeStorageBytes: Number(RATES.freeStorageBytes), topUpMinCents: CREDIT.minTopUpCents, currency: 'USD' },
    topUpUrl: `${view.publicUrl ?? ''}/settings#billing`,
  };
}
