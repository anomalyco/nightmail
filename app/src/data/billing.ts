import { request, type RequestScope } from './live'

// Billing (hosted only): a prepaid USD balance that usage comes off hourly, the free allowance, auto-recharge and the
// saved card. Money crosses the API as integer micro-cents in strings (1¢ = 1,000,000 µ¢); inputs are whole cents.
// Amounts are null for members and read-only credentials; GET /v1/me carries the state for the app-wide banner.
export type Enforcement = 'off' | 'shadow' | 'enforce'
export type BillingState = { sending: 'ok' | 'low' | 'paused'; receiving: 'ok' | 'grace' | 'held'; autoRecharge: 'off' | 'on' | 'pending' | 'failed' | 'capped' }
export interface FreeAllowance { limit: number; used: number; left: number }
export interface BillingSummary {
  enforcement: Enforcement
  mode: 'prepaid' | 'exempt'
  state: BillingState
  balance: { paid: string; promo: string; unsettled: string; available: string } | null
  /** One allowance per direction, counted separately; emails repeats sent for older clients. received is null unless the
   *  credential may read every received message (owners and admins). */
  free: { month: string; emails: FreeAllowance; sent: FreeAllowance; received: FreeAllowance | null; storage: { limitBytes: number; agedBytes: string } }
  monthToDate: { cost: string } | null
  grace: { unpaidSince: string | null; receiveHoldAt: string | null; writeOffAt: string | null }
  autoRecharge: { enabled: boolean; thresholdCents: number; amountCents: number; monthlyCapCents: number; monthTotalCents: number; disabledReason: string | null; pending: boolean } | null
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null
  prices: { emailPerThousand: string; storagePerGbMonth: string; freeEmails: number; freeSentEmails: number; freeReceivedEmails: number; freeStorageBytes: number; topUpMinCents: number; currency: 'USD' }
  topUpUrl: string
  /** Anomaly made this workspace free: nothing is charged; usage is still measured (monthToDate is what it would cost). */
  freePlan: { until: string | null } | null
}
export type LedgerKind = 'topup' | 'usage' | 'grant' | 'refund_hold' | 'refund_release' | 'dispute' | 'dispute_reversal' | 'write_off' | 'adjustment' | 'expire'
export interface LedgerEntry { id: string; at: string; kind: LedgerKind; amount: string; paid: string; promo: string; balanceAfter: string; description: string; detail: Record<string, unknown>; paymentId: string | null; invoiceUrl: string | null; expiresAt: string | null }
export type PaymentStatus = 'created' | 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled' | 'expired'
export interface Payment { id: string; at: string; kind: 'checkout' | 'saved_card' | 'recharge' | 'setup'; status: PaymentStatus; amountCents: number; taxCents: number | null; totalCents: number | null; card: { brand: string; last4: string } | null; invoiceUrl: string | null; invoicePdf: string | null; receiptUrl: string | null; failure: { code: string; message: string } | null }
export interface UsagePoint { start: string; meter: 'send' | 'receive' | 'omen' | 'storage' | 'byo_send' | 'byo_receive'; quantity: string }
export type AutoRechargeInput = { enabled: boolean; thresholdCents: number; amountCents: number; monthlyCapCents: number }
type Page<T> = { data: T[]; nextCursor: string | null }

export const billingApi = (scope: RequestScope | 'unscoped') => ({
  get: (signal?: AbortSignal) => request<BillingSummary>('/v1/billing', { signal, scope }),
  usage: (query: { from?: string; to?: string; granularity?: 'hour' | 'day' | 'month'; meter?: UsagePoint['meter'] }, signal?: AbortSignal) =>
    request<{ data: UsagePoint[] }>(`/v1/billing/usage?${new URLSearchParams(Object.entries(query).filter(([, v]) => v) as [string, string][])}`, { signal, scope }),
  ledger: (cursor: string | undefined, signal?: AbortSignal, limit = 20) => request<Page<LedgerEntry>>(`/v1/billing/ledger?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal, scope }),
  payments: (cursor: string | undefined, signal?: AbortSignal) => request<Page<Payment>>(`/v1/billing/payments?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal, scope }),
  payment: (id: string, signal?: AbortSignal) => request<Payment>(`/v1/billing/payments/${encodeURIComponent(id)}`, { signal, scope }),
  topUp: (input: { amountCents: number; method: 'checkout' | 'saved_card' }) => request<{ attemptId: string; status: PaymentStatus; checkoutUrl: string | null; expiresAt: string | null }>('/v1/billing/top-ups', { method: 'POST', body: input, idempotencyKey: crypto.randomUUID(), scope }),
  autoRecharge: (input: AutoRechargeInput) => request<BillingSummary>('/v1/billing/auto-recharge', { method: 'PUT', body: input, scope }),
  setupCard: () => request<{ checkoutUrl: string; expiresAt: string }>('/v1/billing/payment-method', { method: 'POST', scope }),
  removeCard: () => request<BillingSummary>('/v1/billing/payment-method', { method: 'DELETE', scope }),
})

// ---------- money for people ----------
const UC_PER_CENT = 1_000_000n
/** "$12.34", "−$0.50"; four decimals below a cent ("$0.0002"), as the API's own formatter does. */
export function usd(uc: string | bigint, options: { sign?: boolean } = {}) {
  const v = typeof uc === 'bigint' ? uc : BigInt(uc), neg = v < 0n, abs = neg ? -v : v
  const digits = abs > 0n && abs < UC_PER_CENT ? 4 : 2
  const scale = 10n ** BigInt(8 - digits), units = (abs + scale / 2n) / scale
  const whole = units / 10n ** BigInt(digits), frac = (units % 10n ** BigInt(digits)).toString().padStart(digits, '0')
  return `${neg ? '−' : options.sign && v > 0n ? '+' : ''}$${whole.toLocaleString('en-US')}.${frac}`
}
export const centsUsd = (cents: number) => usd(BigInt(cents) * UC_PER_CENT)
/** A price the API states in dollars (prices.emailPerThousand "0.20") as µ¢. */
export function priceUc(dollars: string) {
  const [whole, fraction = ''] = dollars.split('.')
  return BigInt(whole) * 100n * UC_PER_CENT + BigInt(fraction.padEnd(8, '0').slice(0, 8))
}
export const total = (b: NonNullable<BillingSummary['balance']>) => BigInt(b.paid) + BigInt(b.promo)
/** Whole dollars typed by a person ("25", "$25", "25.50") as cents, or null. */
export function parseDollars(text: string) {
  const match = /^\s*\$?\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(text)
  return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : null
}
const CARD_BRANDS: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', jcb: 'JCB', diners: 'Diners Club', unionpay: 'UnionPay', link: 'Link' }
export const cardBrand = (brand: string) => CARD_BRANDS[brand.toLowerCase()] ?? brand.charAt(0).toUpperCase() + brand.slice(1)
// Stripe decline codes in plain words, for the auto-recharge banner (the owner email says the same).
const DECLINES: Record<string, string> = {
  card_declined: 'Your card was declined', generic_decline: 'Your card was declined', do_not_honor: 'Your card was declined', insufficient_funds: 'Your card has insufficient funds',
  expired_card: 'Your card has expired', authentication_required: 'Your bank asked to confirm the charge (3-D Secure)', incorrect_cvc: 'The card’s security code was wrong',
  processing_error: 'The card processor had an error', dispute: 'A payment was disputed', early_fraud_warning: 'Your bank flagged the card', payment_method_detached: 'The saved card was removed',
}
export const declineText = (code: string) => DECLINES[code] ?? 'The last charge failed'

/** The session's billing state (GET /v1/me), which every dashboard page has on its first frame. */
export type SessionBilling = Pick<BillingState, 'sending' | 'receiving'> & { enforcement: Enforcement; free?: boolean }
/** Under a tenth of a free allowance left this month. */
const nearlyUsed = (allowance: FreeAllowance | null) => allowance !== null && allowance.left * 10 <= allowance.limit
/** Where a workspace's billing stands, in a word, for Settings → Billing: why it isn't charged, or how the balance is.
 *  A balance near $0 (sending "low") is only Low once usage is past, or nearly past, a free allowance: a workspace that
 *  is still inside both owes nothing, so it is on its Free allowance. That needs this month's allowances, so until the
 *  summary arrives a low balance shows no word rather than one that changes. */
export function billingStatus(state: SessionBilling | null | undefined, summary: Pick<BillingSummary, 'free'> | undefined): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } | null {
  if (!state) return null
  if (state.free) return { label: 'Not charged', tone: 'neutral' }
  if (state.enforcement !== 'enforce') return { label: 'Not charged yet', tone: 'neutral' }
  if (state.receiving === 'held') return { label: 'Receiving held', tone: 'danger' }
  if (state.sending === 'paused') return { label: 'Sending paused', tone: 'danger' }
  if (state.sending === 'low') return !summary ? null : nearlyUsed(summary.free.sent) || nearlyUsed(summary.free.received) ? { label: 'Low', tone: 'warning' } : { label: 'Free allowance', tone: 'neutral' }
  return { label: 'Funded', tone: 'success' }
}
export const monthDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
export const fullDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
