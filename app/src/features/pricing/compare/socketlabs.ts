import { dayOf, fact, formatCount, listOf, nightmail, readOn, tierSizes, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs SocketLabs (/compare/socketlabs): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// SocketLabs' own pricing page on CHECKED: Core and the Pro sizes its slider sells, each with its overage per email.
// Bandwidth past a plan's allotment is billed too ("Bandwidth is $10/GB, prorated to your usage",
// help.socketlabs.com/docs/common-billing-questions), but no plan's allotment is published, so it isn't in these prices.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const SOCKETLABS = 'https://www.socketlabs.com/pricing/'
const tier = (size: number, cents: number, overage: number, quote: string): Tier => ({ size, cents, overage, source: read(SOCKETLABS, quote) })
// Past a plan's emails SocketLabs bills each extra one at the plan's rate, so a smaller plan plus that can cost less than
// the next one up. Its first free month of Core is a trial, not a plan, so it isn't here.
const offer: Offer = {
  id: 'socketlabs', vendor: 'SocketLabs', name: 'SocketLabs', pricing: SOCKETLABS, checked: CHECKED, unit: 'emails', ladder: 'complete',
  counts: 'emails sent', payg: ' plus overage',
  beyond: { text: 'Enterprise, contact sales', source: read(SOCKETLABS, 'Enterprise … Contact Us Custom packages for high-volume senders … 1M+ emails per month') },
  plans: [
    { name: 'Core', tiers: [
      tier(40_000, 3_995, 130, '$ 0 First month, then $39.95/month 40,000 emails/month … Each email over 40,000: $0.00130'),
    ] },
    { name: 'Pro', tiers: [
      tier(100_000, 8_995, 110, 'Pro 100k Scalable Email Platform $ 89 95 Monthly 100,000 emails/month … Each email over 100,000: $0.00110'),
      tier(200_000, 17_000, 95, 'Pro 200k Scalable Email Platform $ 170 00 Monthly 200,000 emails/month … Each email over 200,000: $0.00095'),
      tier(400_000, 32_000, 85, 'Pro 400k Scalable Email Platform $ 320 00 Monthly 400,000 emails/month … Each email over 400,000: $0.00085'),
      tier(800_000, 60_000, 77, 'Pro 800k Scalable Email Platform $ 600 00 Monthly 800,000 emails/month … Each email over 800,000: $0.00077'),
    ] },
  ],
}

const sizes: Entry['sizes'] = [10_000, 100_000, 800_000]
export const socketLabs: Entry = {
  slug: 'socketlabs',
  vendor: 'SocketLabs',
  focus: 'developer',
  offer,
  model: { per: 'email' },
  sizes,
  // 10,000 emails (SocketLabs' smallest plan is 40,000), then every plan size its page lists up to its last (800,000;
  // past it SocketLabs' Enterprise is contact sales).
  steps: [10_000, ...tierSizes(offer, 40_000, Infinity)],
  lead: 'SocketLabs sells a monthly allowance of email and charges for each one past it. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, SocketLabs’ cheapest plan, or a smaller one plus its overage where that costs less. Bandwidth charges not included. List prices before tax.',
  rows: [
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month.`, 'SocketLabs’ trial is a month of Core or a set amount of credits, and sending stops after it unless you upgrade.', read(SOCKETLABS, 'Once you create and verify your account, you have access to a Core plan for one month OR you will receive a set amount of credits to use. … you will lose access to the platform and will no longer be able to send mail at the end of your trial if you do not upgrade')),
  ],
  // SocketLabs' readers first see the API, the allowances and receiving.
  panels: ['send', 'free', 'receive', 'agent', 'campaign', 'domain', 'route'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} emails, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
