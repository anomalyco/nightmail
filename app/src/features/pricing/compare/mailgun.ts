import { dayOf, fact, formatCount, listOf, nightmail, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs Mailgun (/compare/mailgun): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// Mailgun's own pages on CHECKED: the plans on its pricing page (pricing.md is its text), and each plan's overage in its
// help centre.
const CHECKED = '2026-11-24'
const read = readOn(CHECKED)

const MAILGUN = 'https://www.mailgun.com/pricing/'
const PRICES = 'https://www.mailgun.com/pricing.md'
const OVERAGE = 'https://help.mailgun.com/hc/en-us/articles/6745531451547-What-happens-if-I-send-more-emails-than-my-monthly-plan-provides'
const tier = (size: number, cents: number, quote: string, overage: number, row: string): Tier =>
  ({ size, cents, overage, source: read(PRICES, quote), overageSource: read(OVERAGE, `Each US Dollar ($) amount is the cost per 1,000 emails sent… ${row}`) })
const users = { count: null, source: read(MAILGUN, 'Every Mailgun plan (except free and basic) allows you to add as many users as you need to your account at no additional cost.') }
// Every size Mailgun's pricing page sells its paid plans at. Past a plan's emails Mailgun bills each extra 1,000 at the
// plan's rate, so a smaller plan plus that can cost less than the next one up. Its free plan (100 emails a day) is below
// every size here.
const offer: Offer = {
  id: 'mailgun', vendor: 'Mailgun', name: 'Mailgun', pricing: MAILGUN, checked: CHECKED, unit: 'emails', ladder: 'complete',
  counts: 'emails sent', payg: ' plus overage',
  beyond: { text: 'Enterprise, price on request', source: read(PRICES, '### Enterprise - **Price:** Upon request (contact sales) - **Volume:** Custom / high volume') },
  plans: [
    { name: 'Basic', tiers: [
      tier(10_000, 1_500, '### Basic - **Price:** $15 / month (USD) … - **Included emails:** 10,000 emails/month - **Overage emails:** from $1.80 / 1,000 emails (USD)', 180, '| 10,000 |$1.80 |N/A |N/A'),
    ] },
    { name: 'Foundation', seats: users, tiers: [
      tier(50_000, 3_500, '### Foundation - **Price:** - Up to 50,000 emails/month: $35 / month (USD)', 130, '| 50,000 |$1.80 |$1.30 |N/A'),
      tier(100_000, 7_500, '- Up to 100,000 emails/month: $75 / month (USD) · €69 / month (EUR) · £60 / month (GBP)', 110, '| 100,000 |$1.80 |$1.10 |$1.10'),
    ] },
    { name: 'Scale', seats: users, tiers: [
      tier(100_000, 9_000, '### Scale - **Price (USD):** - Up to 100,000 emails/month: $90 / month', 110, '| 100,000 |$1.80 |$1.10 |$1.10'),
      tier(250_000, 21_500, '- Up to 250,000 emails/month: $215 / month', 90, '| 250,000 |$1.80 |$1.10 |$0.90'),
      tier(500_000, 40_000, '- Up to 500,000 emails/month: $400 / month', 75, '| 500,000 |$1.80 |$1.10 |$0.75'),
      tier(750_000, 55_000, '- Up to 750,000 emails/month: $550 / month', 60, '| 750,000 |$1.80 |$1.10 |$0.60'),
      tier(1_000_000, 70_000, '- Up to 1,000,000 emails/month: $700 / month', 50, '| 1,000,000 |$1.80 |$1.10 |$0.50'),
      tier(2_500_000, 125_000, '- Up to 2,500,000 emails/month: $1,250 / month', 40, '| 2,500,000 |$1.80 |$1.10 |$0.40'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [10_000, 100_000, 1_000_000]
export const mailgun: Entry = {
  slug: 'mailgun',
  vendor: 'Mailgun',
  offer,
  model: { per: 'email' },
  sizes,
  // Every size Mailgun's page sells, from 10,000 (its smallest paid plan) to 2,500,000 (past it Mailgun names no price).
  steps: tierSizes(offer, 10_000, Infinity),
  lead: 'Mailgun sells a monthly allowance of email and charges for each 1,000 past it. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, Mailgun’s cheapest plan, or a smaller one plus its overage where that costs less. List prices before tax.',
  rows: [
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month.`, 'Mailgun’s free plan is 100 emails a day.', read(PRICES, '### Free - **Price:** $0 / month - **Included emails:** 100 emails/day')),
    fact('Receiving and routing on every account', 'Receiving and routing on every account.', 'Mailgun’s free plan has 1 inbound route and Basic 5; full inbound routing starts on Foundation.', read(PRICES, 'Free … - 1 inbound route … Basic … - 5 inbound routes … Foundation … - Full access to inbound routing')),
  ],
  // Mailgun's readers first see the API, the allowances and routing.
  panels: ['send', 'free', 'route', 'receive', 'agent', 'domain', 'campaign'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} emails, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
