import { dayOf, fact, formatCount, listOf, nightmail, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs Postmark (/compare/postmark): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// Postmark's own pages on CHECKED: the plans and their overage in the script its pricing page draws them from.
const CHECKED = '2026-11-24'
const read = readOn(CHECKED)

const POSTMARK = 'https://postmarkapp.com/pricing'
const SCRIPT = 'https://postmarkapp.com/dist/js/pricing.44675b0a700fd8b9c0ca.js'
const tier = (size: number, cents: number, overage: number, quote: string): Tier => ({ size, cents, overage, source: read(SCRIPT, quote) })
const users = (count: number | null) => ({ count, source: read(POSTMARK, 'Number of Users Up to 6 users Up to 4 users Up to 6 users Unlimited users') })
// Every size Postmark's pricing page sells each plan at. Past a plan's emails Postmark bills each extra 1,000 at the
// plan's rate ("Extra emails"), so a smaller plan plus that can cost less than the next one up. Its free plan's 100
// emails a month is below every size here.
const offer: Offer = {
  id: 'postmark', vendor: 'Postmark', name: 'Postmark', pricing: POSTMARK, checked: CHECKED, unit: 'emails', ladder: 'complete',
  counts: 'emails sent and received', payg: ' plus extra emails',
  beyond: { text: 'Custom pricing', source: read(POSTMARK, 'Hey Big Sender! Let’s work together to improve your deliverability. Contact our sales team to discuss custom pricing options.') },
  plans: [
    { name: 'Basic', seats: users(4), tiers: [
      tier(10_000, 1_500, 180, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Basic",volume:[… {amount:X.range[0],min:X.range[0],max:X.range[1],base_price:15,overagesPrice:1.8}'),
      tier(50_000, 5_500, 180, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Basic",volume:[… {amount:X.range[1],min:X.range[1],max:X.range[2],base_price:55,overagesPrice:1.8}'),
      tier(125_000, 11_500, 180, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Basic",volume:[… {amount:X.range[2],min:X.range[2],max:X.range[3],base_price:115,overagesPrice:1.8}'),
      tier(300_000, 24_500, 170, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Basic",volume:[… {amount:X.range[3],min:X.range[3],max:X.range[4],base_price:245,overagesPrice:1.7}'),
      tier(700_000, 45_500, 170, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Basic",volume:[… {amount:X.range[4],min:X.range[4],max:X.range[5],base_price:455,overagesPrice:1.7}'),
      tier(1_500_000, 77_500, 170, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Basic",volume:[… {amount:X.range[5],min:X.range[5],max:X.range[6],base_price:775,overagesPrice:1.7}'),
    ] },
    { name: 'Pro', seats: users(6), tiers: [
      tier(10_000, 1_650, 130, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Pro",volume:[… {amount:X.range[0],min:X.range[0],max:X.range[1],base_price:16.5,overagesPrice:1.3}'),
      tier(50_000, 6_050, 130, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Pro",volume:[… {amount:X.range[1],min:X.range[1],max:X.range[2],base_price:60.5,overagesPrice:1.3}'),
      tier(125_000, 12_650, 130, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Pro",volume:[… {amount:X.range[2],min:X.range[2],max:X.range[3],base_price:126.5,overagesPrice:1.3}'),
      tier(300_000, 26_950, 125, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Pro",volume:[… {amount:X.range[3],min:X.range[3],max:X.range[4],base_price:269.5,overagesPrice:1.25}'),
      tier(700_000, 50_050, 125, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Pro",volume:[… {amount:X.range[4],min:X.range[4],max:X.range[5],base_price:500.5,overagesPrice:1.25}'),
      tier(1_500_000, 85_250, 120, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Pro",volume:[… {amount:X.range[5],min:X.range[5],max:X.range[6],base_price:852.5,overagesPrice:1.2}'),
    ] },
    { name: 'Platform', seats: users(null), tiers: [
      tier(10_000, 1_800, 120, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Platform",volume:[… {amount:X.range[0],min:X.range[0],max:X.range[1],base_price:18,overagesPrice:1.2}'),
      tier(50_000, 6_600, 120, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Platform",volume:[… {amount:X.range[1],min:X.range[1],max:X.range[2],base_price:66,overagesPrice:1.2}'),
      tier(125_000, 13_800, 120, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Platform",volume:[… {amount:X.range[2],min:X.range[2],max:X.range[3],base_price:138,overagesPrice:1.2}'),
      tier(300_000, 29_400, 115, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Platform",volume:[… {amount:X.range[3],min:X.range[3],max:X.range[4],base_price:294,overagesPrice:1.15}'),
      tier(700_000, 54_600, 115, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Platform",volume:[… {amount:X.range[4],min:X.range[4],max:X.range[5],base_price:546,overagesPrice:1.15}'),
      tier(1_500_000, 93_000, 115, 'range:[1e4,5e4,125e3,3e5,7e5,15e5,3e6] … name:"Platform",volume:[… {amount:X.range[5],min:X.range[5],max:X.range[6],base_price:930,overagesPrice:1.15}'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [10_000, 125_000, 1_500_000]
export const postmark: Entry = {
  slug: 'postmark',
  vendor: 'Postmark',
  offer,
  model: { per: 'email' },
  sizes,
  // Every size Postmark's page sells, from 10,000 (its smallest paid plan) to 1,500,000 (past it Postmark names no price).
  steps: tierSizes(offer, 10_000, Infinity),
  lead: 'Postmark sells a monthly allowance of email and charges for each 1,000 past it. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, Postmark’s cheapest plan, or a smaller one plus its extra emails where that costs less. List prices before tax.',
  rows: [
    fact('A free allowance for received email', `Received email has its own ${formatCount(nightmail.freeReceived)} free a month.`, 'Postmark counts each processed inbound message as an email.', read('https://postmarkapp.com/support/article/1107-how-does-monthly-pricing-work', 'A sent Transactional or Broadcast message, a Sandboxed test message, and a processed Inbound message all count as 1 email.')),
    fact('Receiving on every account', 'Receiving on every account.', 'Postmark lists inbound processing on its Pro and Platform plans.', read(POSTMARK, 'Pro $16.50 /mo … Inbound email processing … Platform $18.00 /mo … Inbound email processing')),
    fact('Teammates at no charge', 'No charge for teammates.', 'Postmark Basic allows up to 4 users and Pro up to 6.', users(4).source),
  ],
  // Postmark's readers first see the API, receiving and the allowances.
  panels: ['send', 'receive', 'free', 'team', 'agent', 'domain', 'campaign'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} emails, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
