import { dayOf, fact, formatCount, listOf, nightmail, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs Mailtrap (/compare/mailtrap): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// Mailtrap's own pages on CHECKED: the Email Live Sending plans on its pricing page (monthly billing), and its plans docs.
// Mailtrap counts sent and received email against one quota. Its paid plans bill extra emails past the quota, but each
// plan caps that overage at a level its pages don't publish, so only the plans' own sizes are priced here, and a size
// between two is priced at the next plan up.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const MAILTRAP = 'https://mailtrap.io/pricing/'
const PRICES = 'https://mailtrap.io/pricing.md'
const tier = (size: number, cents: number, quote: string): Tier => ({ size, cents, source: read(MAILTRAP, quote) })
const free = read(MAILTRAP, 'Free To try out Mailtrap $ 0 per month 4,000 emails 1 user 3 days of email logs 1 domain 150 emails/day')
const offer: Offer = {
  id: 'mailtrap', vendor: 'Mailtrap', name: 'Mailtrap', pricing: MAILTRAP, checked: CHECKED, unit: 'emails', ladder: 'complete',
  counts: 'emails sent and received',
  beyond: { text: 'Custom, through sales', source: read(PRICES, '| Custom     | Talk to Sales | Talk to Sales      | Talk to Sales   | Unlimited (more than 2,500,000) |') },
  plans: [
    { name: 'Free', note: '150 a day', tiers: [{ size: 4_000, cents: 0, source: free }] },
    { name: 'Basic', tiers: [
      tier(10_000, 1_500, 'Basic … $ 15 per month 10,000 emails … 3 users … 5 domains'),
      tier(50_000, 2_000, 'Basic … $ 20 per month 50,000 emails'),
      tier(100_000, 3_000, 'Basic … $ 30 per month 100,000 emails'),
    ] },
    { name: 'Business', tiers: [
      tier(100_000, 8_500, 'Business … $ 85 per month 100,000 emails … Dedicated IP'),
      tier(250_000, 20_000, 'Business … $ 200 per month 250,000 emails'),
      tier(500_000, 30_000, 'Business … $ 300 per month 500,000 emails'),
      tier(750_000, 45_000, 'Business … $ 450 per month 750,000 emails'),
    ] },
    { name: 'Enterprise', tiers: [
      tier(1_500_000, 75_000, 'Enterprise … $ 750 per month 1,500,000 emails'),
      tier(2_500_000, 125_000, 'Enterprise … $ 1,250 per month 2,500,000 emails'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [10_000, 100_000, 1_000_000]
export const mailtrap: Entry = {
  slug: 'mailtrap',
  vendor: 'Mailtrap',
  focus: 'developer',
  offer,
  model: { per: 'email' },
  sizes,
  // Every paid plan size Mailtrap's page lists, from 10,000 to its last (2,500,000; past it Mailtrap quotes).
  steps: tierSizes(offer, 10_000, Infinity),
  lead: 'Mailtrap sells a monthly allowance of email, sent and received together. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, Mailtrap’s cheapest plan. List prices before tax.',
  rows: [
    fact('A free allowance for received email', `Received email has its own ${formatCount(nightmail.freeReceived)} free a month.`, 'Mailtrap counts sent and received email against one quota.', read('https://docs.mailtrap.io/account-and-organization/billing/plans.md', 'Emails/mo is a shared quota for sending and receiving combined.')),
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month.`, 'Mailtrap’s free plan is 4,000 emails a month, 150 a day.', free),
    fact('Teammates and domains at no charge', 'No charge for teammates or domains.', 'Mailtrap’s Basic includes 3 users and 5 sending domains.', read(PRICES, '| Sending domains | 1 | 5 | 100 | Unlimited | … | Users | 1 | 3 | 100 | Unlimited |')),
  ],
  // Mailtrap's readers first see the API, the allowances and receiving.
  panels: ['send', 'free', 'receive', 'team', 'domain', 'agent', 'campaign'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} emails, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
