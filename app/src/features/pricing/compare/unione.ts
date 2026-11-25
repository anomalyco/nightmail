import { dayOf, fact, formatCount, listOf, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs UniOne (/compare/unione): a comparison's whole entry (prices.ts, Entry). Every figure was read on UniOne's
// own pricing page on CHECKED: the Standard plan's sizes, and the rate for each 1,000 past each one.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const UNIONE = 'https://unione.io/en/pricing'
const EXTRA = 'Extra messages Plan - $/1,000 ≤ 100K - $0.75 150K - $0.70 300K - $0.60 700K - $0.50 1,5M - $0.45 3M - $0.30'
const tier = (size: number, cents: number, overage: number, row: string): Tier => ({ size, cents, overage, source: read(UNIONE, `${row} … ${EXTRA}`) })
// Every size UniOne sells Standard at. Past a plan's emails UniOne charges each extra 1,000 at the plan's rate, so a
// smaller plan plus that can cost less than the next one up (700,000 plus 300 × $0.50 is $450 at 1,000,000, against
// $600 for 1.5 million). Its 4-month trial isn't a plan, and StartUp 6K (what the trial becomes) is below every size
// here; a free plan of 100 emails a day appears only in its pricing.md, not on its pricing page, so it isn't here.
const offer: Offer = {
  id: 'unione', vendor: 'UniOne', name: 'UniOne', pricing: UNIONE, checked: CHECKED, unit: 'emails', ladder: 'complete',
  counts: 'emails sent', payg: ' plus overage',
  beyond: { text: 'Individual, contact sales', source: read(UNIONE, 'Individual 5 million or more Contact us') },
  plans: [
    { name: 'Standard', tiers: [
      tier(10_000, 600, 75, 'Standard 10,000 $6/month'),
      tier(20_000, 1_100, 75, 'Standard 20,000 $11/month'),
      tier(50_000, 2_500, 75, 'Standard 50,000 $25/month'),
      tier(100_000, 4_000, 75, 'Standard 100,000 $40/month'),
      tier(150_000, 7_500, 70, 'Standard 150,000 $75/month'),
      tier(300_000, 15_000, 60, 'Standard 300,000 $150/month'),
      tier(700_000, 30_000, 50, 'Standard 700,000 $300/month'),
      tier(1_500_000, 60_000, 45, 'Standard 1.5 million $600/month'),
      tier(3_000_000, 85_000, 30, 'Standard 3 million $850/month'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [10_000, 100_000, 1_000_000]
export const uniOne: Entry = {
  slug: 'unione',
  vendor: 'UniOne',
  focus: 'developer',
  offer,
  model: { per: 'email' },
  sizes,
  // Every size UniOne's page sells Standard at, from 10,000 to 1,500,000 (the fader stops by 2,500,000, so not its
  // 3 million).
  steps: tierSizes(offer, 10_000, 2_500_000),
  lead: 'UniOne sells a monthly allowance of email and charges for each 1,000 past it. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, UniOne’s cheapest Standard plan, or a smaller one plus its overage where that costs less. List prices before tax.',
  rows: [
    fact('Charged per email', 'Each email is charged as it’s sent, with no plan size to pick.', 'UniOne’s Standard plan starts at $6 a month for 10,000 emails.', read(UNIONE, 'Standard For 10,000 emails/month $6 / month 10 000 emails/month')),
  ],
  // UniOne's readers first see the API, the allowances and receiving.
  panels: ['send', 'free', 'receive', 'agent', 'campaign', 'domain', 'route'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} emails, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
