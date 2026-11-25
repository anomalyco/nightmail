import { dayOf, fact, formatCount, listOf, readOn, tierSizes, type Entry, type Offer } from '../prices.ts'

// Nightmail vs CloudMailin (/compare/cloudmailin): a comparison's whole entry (prices.ts, Entry), on received email,
// which CloudMailin is for. Every figure was read on CloudMailin's own pages on CHECKED.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const CLOUDMAILIN = 'https://www.cloudmailin.com/plans-and-pricing'
// Each plan's received emails a month (the Corporate tiers from the data its pricing page draws them from). No overage
// is published: past a plan, it's the next one up. Plans also differ in message size (512 KB on Free, 2 MB on Starter,
// then 10 MB and 50 MB), which these prices don't weigh.
const corporate = (size: number, cents: number, quote: string) => ({ size, cents, source: read(CLOUDMAILIN, quote) })
const offer: Offer = {
  id: 'cloudmailin', vendor: 'CloudMailin', name: 'CloudMailin', pricing: CLOUDMAILIN, checked: CHECKED, unit: 'emails', ladder: 'complete',
  counts: 'emails received',
  beyond: { text: 'Dedicated from $1,499, or custom', source: read(CLOUDMAILIN, 'Dedicated From $1,499 /mo Dedicated cluster … Need something bespoke? Custom volumes, SLAs, or integration support') },
  plans: [
    { name: 'Free', tiers: [{ size: 10_000, cents: 0, source: read(CLOUDMAILIN, 'Free Plan 10,000 emails/mo · 512KB per message · No card required') }] },
    { name: 'Starter', tiers: [{ size: 10_000, cents: 2_500, source: read(CLOUDMAILIN, 'Starter $25 /mo 10,000 emails/mo 2MB per message') }] },
    { name: 'Professional', tiers: [{ size: 20_000, cents: 4_500, source: read(CLOUDMAILIN, 'Professional $45 /mo 20,000 emails/mo 10MB per message') }] },
    { name: 'Premium', tiers: [{ size: 40_000, cents: 8_500, source: read(CLOUDMAILIN, 'Premium $85 /mo 40,000 emails/mo 50MB per message') }] },
    { name: 'Corporate', tiers: [
      corporate(100_000, 20_000, '"title":"Corporate 100k","emails":100000,"priceLabel":"$200"'),
      corporate(500_000, 40_000, '"title":"Corporate 500k","emails":500000,"priceLabel":"$400"'),
      corporate(2_000_000, 80_000, '"title":"Corporate 2M","emails":2000000,"priceLabel":"$800"'),
      corporate(5_000_000, 129_900, '"title":"Corporate 5M","emails":5000000,"priceLabel":"$1,299"'),
      corporate(7_000_000, 179_900, '"title":"Corporate 7M","emails":7000000,"priceLabel":"$1,799"'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [20_000, 100_000, 2_000_000]
export const cloudMailin: Entry = {
  slug: 'cloudmailin',
  vendor: 'CloudMailin',
  focus: 'developer',
  offer,
  model: { per: 'received' },
  sizes,
  // From 20,000 received (up to its free 10,000 both cost $0; Nightmail receives 20,000 free) to 7,000,000, its last tier.
  steps: tierSizes(offer, 20_000, Infinity),
  lead: 'CloudMailin sells monthly allowances of received email, delivered to your app. Nightmail charges for each email received past its free allowance.',
  assume: 'Emails received, nothing sent, CloudMailin’s cheapest plan for the volume; message size limits not weighed. List prices before tax.',
  rows: [
    fact('Your own domain on every workspace', 'Receive at your own domains on every workspace.', 'CloudMailin’s custom domains and catch-all receiving come with its paid plans.', read(CLOUDMAILIN, 'All paid plans include Custom Domains Use your own domain Catch-All Receiving *@yourdomain.com')),
    fact('Campaigns and newsletters too', 'Campaigns and newsletters in the same account.', 'CloudMailin’s sending is for transactional email only.', read('https://docs.cloudmailin.com/outbound/', 'The CloudMailin outbound system only allows you to send transactional email messages. Marketing or bulk messages are not permitted.')),
  ],
  // CloudMailin's readers first see receiving, routing and the allowances.
  panels: ['receive', 'route', 'free', 'agent', 'domain', 'send', 'campaign'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} received emails, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
