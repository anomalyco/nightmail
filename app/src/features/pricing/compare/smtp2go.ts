import { dayOf, fact, formatCount, listOf, nightmail, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs SMTP2GO (/compare/smtp2go): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// SMTP2GO's own pages on CHECKED: the plans on its pricing page as it renders with monthly billing ($15 for 10,000; the
// page's no-script fallback shows older figures, which aren't used).
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const SMTP2GO = 'https://www.smtp2go.com/pricing/'
const tier = (size: number, cents: number, overage: number, quote: string): Tier => ({ size, cents, overage, source: read(SMTP2GO, quote) })
const free = read(SMTP2GO, 'Free Plan … $ 0/mo For testing & sending low volumes. Limited to 200 emails/day. 1,000 emails/mo … Extra emails not permitted')
// Every size SMTP2GO's pricing page sells its plans at. Past a paid plan's emails SMTP2GO bills each extra 1,000 at the
// tier's rate, so a smaller plan plus that can cost less than the next one up. Its page lists no plan between 1,000,000
// and Premier, over 3,000,000.
const offer: Offer = {
  id: 'smtp2go', vendor: 'SMTP2GO', name: 'SMTP2GO', pricing: SMTP2GO, checked: CHECKED, unit: 'emails', ladder: 'complete',
  counts: 'emails sent', payg: ' plus overage',
  beyond: { text: 'Premier, custom pricing over 3,000,000 a month', source: read(SMTP2GO, 'Premier Custom Personalized setup & support for enterprise-level senders. Over 3,000,000 emails/mo') },
  plans: [
    { name: 'Free', note: '200 a day', tiers: [{ size: 1_000, cents: 0, source: free }] },
    { name: 'Starter', tiers: [
      tier(10_000, 1_500, 120, 'Starter … $ 15/mo … 10,000 emails/mo … Extra emails: $1.20 / thousand'),
      tier(50_000, 3_000, 100, 'Starter … $ 30/mo … 50,000 emails/mo … Extra emails: $1 / thousand'),
    ] },
    { name: 'Professional', tiers: [
      tier(100_000, 7_500, 85, 'Professional $ 75/mo … 100,000 emails/mo … Dedicated IP address … Extra emails: $0.85 / thousand'),
      tier(250_000, 17_000, 70, 'Professional … $ 170/mo … 250,000 emails/mo … Extra emails: $0.70 / thousand'),
      tier(500_000, 28_000, 60, 'Professional … $ 280/mo … 500,000 emails/mo … Extra emails: $0.60 / thousand'),
      tier(1_000_000, 52_000, 50, 'Professional … $ 520/mo … 1,000,000 emails/mo … Extra emails: $0.50 / thousand'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [10_000, 100_000, 1_000_000]
export const smtp2go: Entry = {
  slug: 'smtp2go',
  vendor: 'SMTP2GO',
  focus: 'developer',
  offer,
  model: { per: 'email' },
  sizes,
  // Every paid plan size SMTP2GO's page lists, from 10,000 to its last (1,000,000).
  steps: tierSizes(offer, 10_000, Infinity),
  lead: 'SMTP2GO sells a monthly allowance of email and charges for each 1,000 past it. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, SMTP2GO’s cheapest plan, or a smaller one plus its overage where that costs less. List prices before tax.',
  rows: [
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month.`, 'SMTP2GO’s free plan is 1,000 emails a month, 200 a day.', free),
    fact('Campaigns and contacts', 'Campaigns and newsletters, with no charge for contacts.', 'SMTP2GO doesn’t manage contacts.', read('https://www.smtp2go.com/blog/smtp2go-questions-answered', 'Can I upload contacts? We do not cater to contact management')),
  ],
  // SMTP2GO's readers first see the API, the allowances and the campaigns it leaves out.
  panels: ['send', 'free', 'campaign', 'contacts', 'receive', 'agent', 'domain'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} emails, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
