import { dayOf, fact, formatCount, listOf, nightmail, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs MailChannels (/compare/mailchannels): a comparison's whole entry (prices.ts, Entry). Every figure was
// read on MailChannels' own pages on CHECKED: the Email API's Pay as You Grow sizes in its pricing page's size menu,
// billed monthly. It has no overage: sending pauses at a plan's limit. Its free plan (100 emails a day) isn't a $0 tier
// here: it sends only to the account's verified users until a card is added.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const MAILCHANNELS = 'https://www.mailchannels.com/pricing/'
const tier = (size: number, cents: number, dollars: string, label: string): Tier =>
  ({ size, cents, source: read(MAILCHANNELS, `<option value="${dollars}" data-units="${size}" data-billing_term="Billed monthly">${label}</option>`) })
const offer: Offer = {
  id: 'mailchannels', vendor: 'MailChannels', name: 'MailChannels Email API', pricing: MAILCHANNELS, checked: CHECKED, unit: 'emails', ladder: 'complete',
  counts: 'emails sent, one per recipient',
  beyond: { text: 'Custom pricing, contact sales', source: read(MAILCHANNELS, 'Custom pricing Let\'s talk For 1,500,001+ emails per month') },
  plans: [
    { name: 'Pay as You Grow', tiers: [
      tier(10_000, 1_000, '10.00', '10,000'),
      tier(50_000, 1_500, '15.00', '50,000'),
      tier(100_000, 3_000, '30.00', '100,000'),
      tier(200_000, 6_000, '60.00', '200,000'),
      tier(300_000, 9_000, '90.00', '300,000'),
      tier(500_000, 15_000, '150.00', '500,000'),
      tier(750_000, 22_500, '225.00', '750,000'),
      tier(1_000_000, 30_000, '300.00', '1,000,000'),
      tier(1_500_000, 45_000, '450.00', '1,500,000'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [10_000, 100_000, 1_000_000]
export const mailChannels: Entry = {
  slug: 'mailchannels',
  vendor: 'MailChannels',
  focus: 'developer',
  offer,
  model: { per: 'email' },
  sizes,
  // Every size MailChannels' page sells, from 10,000 to 1,500,000 (past it MailChannels prices on request).
  steps: tierSizes(offer, 10_000, Infinity),
  lead: 'MailChannels sells a monthly allowance of email and pauses sending at its limit. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, MailChannels’ cheapest Pay as You Grow plan. List prices before tax.',
  rows: [
    fact('Receiving on every workspace', 'Receiving with webhooks, routing rules and inboxes on every workspace.', 'MailChannels’ Email API sends only: it doesn’t receive, parse or store replies.', read('https://docs.mailchannels.com/email-api/inbound-email-replies', 'MailChannels Email API is focused on outbound email delivery. … It does not provide an inbound message content API for receiving, parsing, or storing replies.')),
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month.`, 'MailChannels’ free plan is 100 emails a day, on up to 3 domains.', read(MAILCHANNELS, 'Free For developers testing, prototyping, or running small projects $0 /mo Up to 3,000 emails per month No overages (100 emails per day) … Up to 3 domains')),
  ],
  // MailChannels' readers first see the API, the allowances and the receiving it leaves out.
  panels: ['send', 'free', 'receive', 'route', 'agent', 'campaign', 'domain'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} emails, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
