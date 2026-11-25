import { dayOf, fact, formatCount, listOf, nightmail, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs MailerSend (/compare/mailersend): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// MailerSend's own pages on CHECKED: each plan's price and overage on its pricing page (monthly billing), and its help
// centre for domains and inbound mail.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const MAILERSEND = 'https://www.mailersend.com/pricing'
const PRICES = 'https://www.mailersend.com/pricing.md'
const tier = (size: number, cents: number, overage: number, quote: string): Tier => ({ size, cents, overage, source: read(MAILERSEND, quote) })
// Every size MailerSend's pricing page sells its plans at. Past a plan's emails MailerSend bills each extra 1,000 at the
// tier's rate, so a smaller plan plus that can cost less than the next one up (10,000 emails: Hobby's 5,000 plus 5 × $1.50).
const offer: Offer = {
  id: 'mailersend', vendor: 'MailerSend', name: 'MailerSend', pricing: MAILERSEND, checked: CHECKED, unit: 'emails', ladder: 'complete',
  counts: 'emails sent', payg: ' plus overage',
  beyond: { text: 'Enterprise, custom pricing', source: read(PRICES, 'Enterprise Price: Custom pricing — contact sales') },
  plans: [
    { name: 'Free', tiers: [{ size: 500, cents: 0, source: read(MAILERSEND, 'Free … Get started for free — includes: 500 emails /month Email API and SMTP relay') }] },
    { name: 'Hobby', tiers: [tier(5_000, 700, 150, 'Hobby … $7.00 /month 5,000 emails /month Extra usage $1.50 /1,000 emails')] },
    { name: 'Starter', tiers: [
      tier(50_000, 3_500, 130, 'Starter … $35.00 /month 50,000 emails /month 100 SMS /month Extra usage $1.30 /1,000 emails'),
      tier(100_000, 6_800, 130, 'Starter … $68.00 /month 100,000 emails /month 350 SMS /month Extra usage $1.30 /1,000 emails'),
      tier(250_000, 16_250, 110, 'Starter … $162.50 /month 250,000 emails /month 1,750 SMS /month Extra usage $1.10 /1,000 emails'),
      tier(500_000, 32_500, 110, 'Starter … $325.00 /month 500,000 emails /month 3,500 SMS /month Extra usage $1.10 /1,000 emails'),
      tier(1_000_000, 60_000, 100, 'Starter … $600.00 /month 1,000,000 emails /month 7,000 SMS /month Extra usage $1.00 /1,000 emails'),
    ] },
    { name: 'Professional', tiers: [
      tier(50_000, 11_000, 130, 'Professional … $110.00 /month 50,000 emails /month 150 SMS /month Extra usage $1.30 /1,000 emails'),
      tier(100_000, 14_000, 130, 'Professional … $140.00 /month 100,000 emails /month 500 SMS /month Extra usage $1.30 /1,000 emails'),
      tier(250_000, 27_500, 100, 'Professional … $275.00 /month 250,000 emails /month 2,500 SMS /month Extra usage $1.00 /1,000 emails'),
      tier(500_000, 52_500, 80, 'Professional … $525.00 /month 500,000 emails /month 5,000 SMS /month Extra usage $0.80 /1,000 emails'),
      tier(1_000_000, 100_000, 60, 'Professional … $1,000.00 /month 1,000,000 emails /month 10,000 SMS /month Extra usage $0.60 /1,000 emails'),
      tier(1_500_000, 135_000, 60, 'Professional … $1,350.00 /month 1,500,000 emails /month 13,000 SMS /month Extra usage $0.60 /1,000 emails'),
      tier(2_000_000, 160_000, 50, 'Professional … $1,600.00 /month 2,000,000 emails /month 15,000 SMS /month Extra usage $0.50 /1,000 emails'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [10_000, 100_000, 1_000_000]
export const mailerSend: Entry = {
  slug: 'mailersend',
  vendor: 'MailerSend',
  focus: 'developer',
  offer,
  model: { per: 'email' },
  sizes,
  // 10,000 emails, then every plan size MailerSend's page lists from 50,000 to its last (Professional's 2,000,000; past it
  // MailerSend quotes).
  steps: [10_000, ...tierSizes(offer, 50_000, Infinity)],
  lead: 'MailerSend sells a monthly allowance of email and charges for each 1,000 past it. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, MailerSend’s cheapest plan, or a smaller one plus its overage where that costs less. List prices before tax.',
  rows: [
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month.`, 'MailerSend’s free plan is 500 emails a month.', offer.plans[0]!.tiers[0]!.source),
    fact('A free allowance for received email', `Received email has its own ${formatCount(nightmail.freeReceived)} free a month.`, 'MailerSend counts each received email it forwards or posts to your endpoint as a sent email.', read('https://www.mailersend.com/help/inbound-route', 'Inbound emails are free to receive but are counted towards your monthly usage when forwarded or posted to your endpoint URL. One forward is equivalent to one sent email.')),
    fact('Domains at no charge', 'No charge per domain.', 'MailerSend charges $4 a month for each extra domain on Starter and above.', read('https://www.mailersend.com/help/plan-add-ons', 'Starter plans and above can purchase up to 50 additional domains through the Domain spaces add-on. Each additional domain costs $4/month.')),
  ],
  // MailerSend's readers first see the API, the allowances and receiving.
  panels: ['send', 'free', 'receive', 'domain', 'route', 'agent', 'campaign'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} emails, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
