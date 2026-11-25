import { dayOf, fact, formatCount, listOf, nightmail, readOn, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs AhaSend (/compare/ahasend): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// AhaSend's own pages on CHECKED (pricing.md is its pricing page's text). Pro is $10 a month with 25,000 emails, then
// $0.50 per 1,000 up to 1,000,000; its calculator shows the totals rounded up to whole dollars (50,000: $23), so these
// are the rates' exact sums (50,000: $10 + 25 × $0.50 = $22.50). Max costs more at every size here ($80 with 100,000,
// then the same $0.50). Past 1,000,000 AhaSend's page doesn't say whether its lower rates apply to every email or only
// to those past each band, so no price past it is here. So 'points': only these sizes.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const AHASEND = 'https://ahasend.com/pricing'
const PRICES = 'https://ahasend.com/pricing.md'
const RATES = read(PRICES, 'Pro … $10 / €9 / £8 per month, includes 25,000 emails per month. … 25,000 to 1,000,000 emails: $10 / €9 / £8 base, plus $0.50 / €0.45 / £0.40 per 1000 emails')
const pro = (size: number): Tier => ({ size, cents: 1_000 + Math.max(0, size - 25_000) / 1000 * 50, source: RATES })
const free = read(PRICES, 'Includes 1000 emails per month, up to a maximum of 1000 emails. … Yes: 3 domains (Limited to 3 sending domains in the free plan)')
const SIZES = [10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000]
const offer: Offer = {
  id: 'ahasend', vendor: 'AhaSend', name: 'AhaSend', pricing: AHASEND, checked: CHECKED, unit: 'emails', ladder: 'points',
  counts: 'emails sent and received',
  plans: [
    { name: 'Free', startsAtZero: true, max: { size: 1_000, source: free }, tiers: [{ size: 1_000, cents: 0, source: free }] },
    { name: 'Pro', tiers: SIZES.map(pro) },
  ],
}

const sizes: Entry['sizes'] = [10_000, 100_000, 1_000_000]
export const ahasend: Entry = {
  slug: 'ahasend',
  vendor: 'AhaSend',
  focus: 'developer',
  offer,
  model: { per: 'email' },
  sizes,
  steps: SIZES,
  lead: 'AhaSend charges a monthly base with 25,000 emails, then for each 1,000 past it. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, AhaSend’s Pro: $10 a month with 25,000 emails, then $0.50 per 1,000. List prices before tax.',
  rows: [
    fact('A free allowance for received email', `Received email has its own ${formatCount(nightmail.freeReceived)} free a month.`, 'AhaSend counts each received email against the same allowance as sent.', read(PRICES, 'We count both outbound and inbound emails. … **Inbound emails:** Each email received by your domain counts as one email.')),
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month.`, 'AhaSend’s free plan is 1,000 emails a month.', read(PRICES, 'We offer a forever **free plan** that includes 1000 emails per month … you can start with a free account and send up to 1000 emails per month without providing your credit card information.')),
  ],
  // AhaSend's readers first see the API, the allowances and receiving.
  panels: ['send', 'free', 'receive', 'route', 'agent', 'campaign', 'domain'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} emails, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
