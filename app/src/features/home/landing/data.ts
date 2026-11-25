import { COMPARISONS } from '../../pricing/compare/index.ts'
import { dayOf, formatCount, money, nightmail, nightmailBill, theirPrice, type Comparison } from '../../pricing/prices.ts'

// The homepage's price comparison: Nightmail's bill and each sending provider's, from the same checked figures as the
// comparison pages (features/pricing/compare: every competitor price read on the vendor's own page, with the day it was
// read). Nothing here is estimated: a provider whose page prices no plan at a volume has no price there.

/** The providers compared: every comparison of an email API priced by the email sent (Resend, SendGrid, Postmark…). */
export const PROVIDERS: Comparison[] = COMPARISONS.filter(c => c.model.per === 'email')

export type Bill = { usd: number; text: string }
export type Quote = Bill & { plan: string; checked: string }
/** Nightmail's month at `emails` sent (the free allowance first). */
export function ours(emails: number): Bill {
  const bill = nightmailBill(emails, 0)
  return { usd: Number(bill.uc) / 1e8, text: bill.text }
}
/** A provider's month at `emails` sent, as a buyer would pay it, with the day its price was read; null where none was. */
export function theirs(c: Comparison, emails: number): Quote | null {
  const price = theirPrice(c.offer, c.use(emails))
  return price ? { usd: price.cents / 100, text: money(price.cents), plan: price.plan, checked: c.offer.checked } : null
}
export type Row = { key: string; name: string; href: string | null; quote: Bill & { plan?: string; checked?: string } | null }
/** Nightmail and every provider at `emails`, cheapest first; the providers with no price there last, in name order. */
export function ranked(emails: number): Row[] {
  const rows: Row[] = [{ key: 'nightmail', name: 'Nightmail', href: null, quote: ours(emails) }, ...PROVIDERS.map(c => ({ key: c.slug, name: c.offer.vendor, href: c.path, quote: theirs(c, emails) }))]
  return rows.sort((a, b) => a.quote && b.quote ? a.quote.usd - b.quote.usd || a.name.localeCompare(b.name) : a.quote ? -1 : b.quote ? 1 : a.name.localeCompare(b.name))
}
/** The cheapest provider priced at `emails`. */
export function nextCheapest(emails: number) {
  return PROVIDERS.flatMap(c => { const q = theirs(c, emails); return q ? [{ c, q }] : [] }).sort((a, b) => a.q.usd - b.q.usd)[0] ?? null
}

/** The days the providers' prices were read, as one phrase: "checked 25 Nov 2026", or the first and last day. */
export function checkedPhrase() {
  const days = [...new Set(PROVIDERS.map(c => c.offer.checked))].sort()
  return days.length === 1 ? `checked ${dayOf(days[0]!)}` : `checked between ${dayOf(days[0]!)} and ${dayOf(days.at(-1)!)}`
}
/** What every price assumes, in a line (the comparison pages' own terms). */
export const TERMS = 'List prices on each provider’s own pricing page, before tax: its cheapest plan or pay-as-you-go for the month, one recipient per email.'

export const short = (n: number) => n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1000 ? `${n / 1000}k` : String(n)
export { formatCount, nightmail }
