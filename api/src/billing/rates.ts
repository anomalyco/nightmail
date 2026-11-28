// Billing rates, apart from money.ts so a package without its dependencies can read them (the support Worker checks its
// prompt's prices against these). It imports nothing.

// The current rate version, from November 2026. The database prices each UTC month at its own version (billing_rates_in,
// migrations 367, 380 and 476): months before it had 3,000 sent and 3,000 received free and charged $0.10 per 1,000 AI
// decisions. AI decisions are free (omenUc 0): still metered and counted, never charged. freeReceivedEmails must match
// billing_rates_in's free_received for the current month (the billing acceptance test checks it).
export const RATES = { version: 4, emailUc: 20_000n, omenUc: 0n, storageUcPerGbMonth: 25_000_000n, freeSentEmails: 5000, freeReceivedEmails: 20_000, freeStorageBytes: 1_000_000_000n } as const;

/** Prepaid credit: a top-up is $20 to $10,000 before tax (routes.ts), and what is left of it expires 12 months after
 *  purchase (migration 300, billing_credit_lots.expires_at). The public price pages quote these. */
export const CREDIT = { minTopUpCents: 2000, maxTopUpCents: 1_000_000, expiresAfterMonths: 12 } as const;
/** What a person may choose, as the API checks it, the dashboard offers it and the Terms (section 5) state it: a
 *  workspace's first top-up is at most $500 until one succeeds; auto-recharge runs below a threshold of $5 to $1,000,
 *  adds a top-up's amount each time, and adds at most a monthly limit of at least that amount, up to $250,000. */
export const BILLING_LIMITS = {
  firstTopUpMaxCents: 50_000,
  autoRecharge: { minThresholdCents: 500, maxThresholdCents: 100_000, minAmountCents: CREDIT.minTopUpCents, maxAmountCents: CREDIT.maxTopUpCents, maxMonthlyCapCents: 25_000_000 },
} as const;
/** Storage bills received mail kept past this many days (migrations 292 and 314); default mail's raw copy expires then. */
export const STORAGE_AFTER_DAYS = 90;

/** A per-unit rate in micro-cents as US dollars per 1,000 units, as GET /v1/billing and the homepage show it ("0.20"). */
export const perThousandUsd = (uc: bigint) => (Number(uc) * 1000 / 100_000_000).toFixed(2);

/** Micro-cents (1¢ = 1,000,000 µ¢) as "$12.34" or "−$0.50"; four decimals when 0 < |v| < 1¢ ("$0.0002"), rounded half up. */
export const usd = (uc: bigint): string => {
  const neg = uc < 0n, abs = neg ? -uc : uc;
  const digits = abs > 0n && abs < 1_000_000n ? 4 : 2;
  const scale = 10n ** BigInt(8 - digits), units = (abs + scale / 2n) / scale;
  const whole = units / 10n ** BigInt(digits), frac = (units % 10n ** BigInt(digits)).toString().padStart(digits, '0');
  return `${neg ? '−' : ''}$${whole.toLocaleString('en-US')}.${frac}`;
};
/** Whole US cents as a limit is quoted: "$20", "$10,000" (with cents only when there are some). */
export const dollars = (cents: number) => usd(BigInt(cents) * 1_000_000n).replace(/\.00$/, '');
