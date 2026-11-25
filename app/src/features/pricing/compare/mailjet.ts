import { dayOf, fact, formatCount, listOf, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs Mailjet (/compare/mailjet): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// Mailjet's own pages on CHECKED: the monthly prices in its help centre's price update of 9 September 2026 (its pricing
// page opens on annual billing; its monthly figures there are the same), and each plan's overage in its help centre.
const CHECKED = '2026-11-24'
const read = readOn(CHECKED)

const MAILJET = 'https://www.mailjet.com/pricing/'
const PRICES = 'https://documentation.mailjet.com/hc/en-us/articles/25750983876763-Mailjet-Subscription-Pricing-Update-September-9-2026'
const OVERAGE = 'https://documentation.mailjet.com/hc/en-us/articles/8625025643803-Mailjet-Subscription-Management'
const tier = (size: number, cents: number, row: string, overage: number, overageRow: string): Tier =>
  ({ size, cents, overage, source: read(PRICES, `Plan | USD Monthly / Annual | … ${row}`), overageSource: read(OVERAGE, `The price per additional 1,000 emails beyond any plan limit is: … ${overageRow}`) })
const free = read(MAILJET, 'Free $ 0 /month 6,000 emails/month 200 emails per day … 1,000 contacts')
// Every size Mailjet sells its plans at. Past a plan's emails Mailjet bills each extra 1,000 at the plan's rate, so a
// smaller plan plus that can cost less than the next one up.
const offer: Offer = {
  id: 'mailjet', vendor: 'Mailjet', name: 'Mailjet', pricing: MAILJET, checked: CHECKED, unit: 'emails', ladder: 'complete',
  counts: 'emails sent', payg: ' plus overage',
  beyond: { text: 'Custom, by quote', source: read(MAILJET, 'Custom Custom Enterprise Plans for high-volume senders … Get a quote') },
  plans: [
    { name: 'Free', note: '200 a day', tiers: [{ size: 6_000, cents: 0, source: free }] },
    { name: 'Starter', tiers: [tier(8_000, 900, 'Starter | $9.00 / $8.10', 258, 'Starter 8k | $2.58')] },
    { name: 'Essential', tiers: [
      tier(15_000, 1_900, 'Essential 15k | $19.00 / $17.10', 258, 'Essential 15k | $2.58'),
      tier(50_000, 4_000, 'Essential 50k | $40.00 / $36.00', 152, 'Essential 50k | $1.52'),
    ] },
    { name: 'Premium', tiers: [
      tier(15_000, 2_900, 'Premium 15k | $29.00 / $26.10', 258, 'Premium 15k | $2.58'),
      tier(50_000, 5_900, 'Premium 50k | $59.00 / $53.10', 152, 'Premium 50k | $1.52'),
      tier(100_000, 11_200, 'Premium 100k | $112.00 / $100.80', 139, 'Premium 100k | $1.39'),
      tier(250_000, 26_500, 'Premium 250k | $265.00 / $238.50', 125, 'Premium 250k | $1.25'),
      tier(500_000, 49_900, 'Premium 500k | $499.00 / $449.10', 120, 'Premium 500k | $1.20'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [10_000, 100_000, 500_000]
export const mailjet: Entry = {
  slug: 'mailjet',
  vendor: 'Mailjet',
  offer,
  model: { per: 'email' },
  sizes,
  // 8,000 (Mailjet's smallest paid plan; up to its free 6,000 both cost $0), 10,000, then every size Mailjet's page sells
  // up to its last (500,000; past it Mailjet quotes).
  steps: [8_000, 10_000, ...tierSizes(offer, 15_000, Infinity)],
  lead: 'Mailjet sells a monthly allowance of email and charges for each 1,000 past it. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, Mailjet’s cheapest plan, or a smaller one plus its overage where that costs less. List prices before tax.',
  rows: [
    fact('Receiving on every account', 'Receiving email on every account.', 'Mailjet’s Parse API starts on Premium 50k.', read('https://dev.mailjet.com/docs/email-api/parse-api/basic-setup', 'Parse API is available only for users on paid Mailjet plans (Premium 50k and above).')),
    fact('Teammates at no charge', 'No charge for teammates.', 'Mailjet shares an account with other users on Premium and Custom only.', read('https://documentation.mailjet.com/hc/en-us/articles/360043000173-Account-Sharing', 'This feature is included in the following plans. X Free X Starter X Essential ✓ Premium ✓ Custom')),
    fact('Contacts at no charge', 'No charge for contacts.', 'Mailjet’s free plan holds 1,000 contacts and Starter 2,000.', read(MAILJET, 'Features include: 1,000 contacts … Everything from Free, plus: 2,000 contacts … Everything from Starter, plus: Unlimited contacts')),
  ],
  // Mailjet's readers first see the API, receiving and the team.
  panels: ['send', 'receive', 'team', 'contacts', 'free', 'agent', 'campaign'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} emails, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
