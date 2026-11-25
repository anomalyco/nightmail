import { dayOf, fact, formatCount, listOf, nightmail, readOn, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs Bird (/compare/bird): a comparison's whole entry (prices.ts, Entry). Every figure was read on Bird's own
// pages on CHECKED. Bird sells SparkPost's email: sparkpost.com/pricing redirects to bird.com/pricing/email?sp=true.
const CHECKED = '2026-11-24'
const read = readOn(CHECKED)

const BIRD = 'https://bird.com/pricing/email'
const PRICES = 'https://bird.com/pricing/email.md'
// Bird's paid plans have no allowance: each takes a monthly deposit, and every email is charged from the balance at the
// plan's rate per 1,000, topped up when it runs out ("Paid Email plans are funding plans. They have no monthly email
// allowance or plan volume cap. Every email is charged from the wallet at the plan's published rate per 1,000",
// bird.com/docs/knowledge-base/billing/plans-and-pricing). A month costs its deposit or its emails, whichever is more.
// At every size here Email Startup's emails cost more than its $15 deposit, so they are the month's price, and no other
// plan costs less: Growth's rate is higher, and each Scale plan's deposit ($1,000 and up) is at least Startup's emails up
// to 2,500,000. So 'points': only these sizes, each Startup's rate times the emails.
const RATES = '| Monthly balance deposit | $15 | $250 | $1,000 | $2,500 | $5,000 | $10,000 | | Transactional email rate per 1,000 | $0.40 | $0.45 | $0.35 | $0.30 | $0.25 | $0.20 |'
const startup = (size: number): Tier => ({ size, cents: size / 1000 * 40, source: read(PRICES, RATES) })
const SIZES = [50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000]
const offer: Offer = {
  id: 'bird', vendor: 'Bird', name: 'Bird', pricing: BIRD, checked: CHECKED, unit: 'emails', ladder: 'points',
  counts: 'emails sent, from a monthly deposit',
  plans: [{ name: 'Email Startup', tiers: SIZES.map(startup) }],
}

const sizes: Entry['sizes'] = [50_000, 100_000, 1_000_000]
export const bird: Entry = {
  slug: 'bird',
  vendor: 'Bird',
  offer,
  model: { per: 'email' },
  sizes,
  // From 50,000 emails, where Email Startup's emails first cost more than its deposit.
  steps: SIZES,
  lead: 'Bird charges every email from a monthly deposit, with no free sends on paid plans. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, Bird’s Email Startup: every email at its $0.40 per 1,000, from its $15 monthly deposit and top-ups. List prices before tax.',
  rows: [
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month.`, 'Bird charges its paid plans from the first email.', read(PRICES, 'Paid plans include no free sends. Email is charged from the first send')),
    fact('Inboxes at no charge', 'No charge per inbox.', 'Bird’s Email Startup includes 10 mailboxes and Growth 25.', read(PRICES, '| Mailboxes | 5 | 10 | 25 | 100 |')),
  ],
  // Bird's readers first see the API, the allowances and the inboxes.
  panels: ['send', 'free', 'receive', 'agent', 'campaign', 'domain', 'route'],
  description: `SparkPost’s pricing now opens Bird’s. Monthly prices at ${listOf(sizes.map(formatCount))} emails, checked ${dayOf(CHECKED)}.`,
}
