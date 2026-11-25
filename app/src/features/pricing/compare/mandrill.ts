import { dayOf, fact, formatCount, listOf, nightmail, readOn, type Entry, type Offer, type Plan } from '../prices.ts'

// Nightmail vs Mandrill (/compare/mandrill): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// Mailchimp's own pages on CHECKED. Mandrill is Mailchimp's transactional email (renamed Mailchimp Transactional in
// 2025: https://mailchimp.com/features/transactional-email/), sold in blocks of 25,000 emails a month on top of a
// Mailchimp Standard or Premium plan, which these prices leave out.
const CHECKED = '2026-11-24'
const read = readOn(CHECKED)

const MANDRILL = 'https://mailchimp.com/pricing/transactional-email/'
const BLOCK = 25_000
// Every block is priced at the rate for the number bought (its calculator: 20 blocks $400, 21 blocks $378, 40 blocks
// $720, 80 blocks $1,280), so more blocks can cost less than fewer: each number of blocks is a plan of its own here,
// and the cheapest one that holds a size is its price.
const BANDS = [
  { upTo: 20, cents: 2_000, source: read(MANDRILL, '1 to 20 blocks 1 to 500k emails $20/block $20 per block') },
  { upTo: 40, cents: 1_800, source: read(MANDRILL, '21 to 40 blocks 500k to 1M emails $18/block $18 per block') },
  { upTo: 80, cents: 1_600, source: read(MANDRILL, '41 to 80 blocks 1M to 2M emails $16/block $16 per block') },
  { upTo: 120, cents: 1_400, source: read(MANDRILL, '81 to 120 blocks 2M to 3M emails $14/block $14 per block') },
]
const blocks = (n: number): Plan => {
  const band = BANDS.find(b => n <= b.upTo)!
  return { name: `${n} block${n === 1 ? '' : 's'}`, tiers: [{ size: n * BLOCK, cents: n * band.cents, source: band.source }] }
}
// Up to 100 blocks (2,500,000 emails), the fader's last size: more blocks cost at least 101 × $14 = $1,414, more than
// any number here. (Past it a block costs $12 from 121, which undercuts 104 blocks and up, so no price past it is here.)
const offer: Offer = {
  id: 'mandrill', vendor: 'Mandrill', name: 'Mandrill', pricing: MANDRILL, checked: CHECKED, unit: 'emails', ladder: 'complete',
  counts: 'emails sent, in blocks of 25,000',
  plans: Array.from({ length: 100 }, (_, i) => blocks(i + 1)),
}

const sizes: Entry['sizes'] = [10_000, 100_000, 1_000_000]
export const mandrill: Entry = {
  slug: 'mandrill',
  vendor: 'Mandrill',
  offer,
  model: { per: 'email' },
  sizes,
  // 10,000 emails (one block), then sizes up to 2,500,000 (100 blocks).
  steps: [10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000],
  lead: 'Mandrill sells email in blocks of 25,000 a month, on top of a Mailchimp plan. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, Mandrill’s cheapest number of blocks, without the Mailchimp plan it needs. List prices before tax.',
  rows: [
    fact('No plan to buy first', 'No plan to buy first.', 'Mandrill is an add-on to Mailchimp’s Standard and Premium plans.', read(MANDRILL, 'Transactional Email is available as an add-on to Mailchimp’s Standard and Premium plans, or the legacy Monthly Plan.')),
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month.`, 'Mandrill’s demo is 500 emails, once, to your own domain.', read('https://mailchimp.com/help/transactional-email-demo/', 'You can send up to 500 transactional emails to any email address on your verified domain. … The emails included with the demo do not expire or renew.')),
  ],
  // Mandrill's readers first see the API, the allowances and the campaigns it leaves to Mailchimp.
  panels: ['send', 'free', 'campaign', 'receive', 'agent', 'domain', 'route'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} emails, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
