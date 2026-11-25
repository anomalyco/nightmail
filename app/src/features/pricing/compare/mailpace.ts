import { dayOf, fact, formatCount, listOf, nightmail, readOn, type Entry, type Offer, type Tier } from '../prices.ts'

// Nightmail vs MailPace (/compare/mailpace): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// MailPace's own pages on CHECKED. MailPace has one plan: $10 a month covers the first 10,000 emails sent or received,
// and each 1,000 after that is $1 (its calculator's script: "this.emailsSent>1e4?this.basePrice+this.pricePerThousand*
// (this.emailsSent-1e4)/1e3:this.basePrice", with both prices loaded from Paddle). So 'points': the sizes its calculator
// was read at (10,000, 100,000 and 1,000,000), and between them that rate. Its calculator stops at 1,000,000, and no page
// prices more, so nothing past it is here.
const CHECKED = '2026-11-25'
const read = readOn(CHECKED)

const MAILPACE = 'https://mailpace.com/pricing'
const RATE = read('https://checkout.paddle.com/api/2.0/prices?product_ids=687241%2C%20687246&customer_country=US', '"product_title":"Scaling - Monthly","currency":"USD" … "list_price":{"gross":10.0,"net":10.0 … "product_title":"Scaling - 1k Add On (For landing page)","currency":"USD" … "list_price":{"gross":1.0,"net":1.0')
const CALCULATOR: Record<number, string> = {
  10_000: '10,000 emails => $10.00 … The first 10,000 emails $10.00 The next 0 emails $0.00',
  100_000: '100,000 emails => $100.00 … The first 10,000 emails $10.00 The next 90,000 emails $90.00',
  1_000_000: '1,000,000 emails => $1,000.00 … The first 10,000 emails $10.00 The next 990,000 emails $990.00',
}
const scaling = (size: number): Tier => ({ size, cents: 1_000 + (size - 10_000) / 1000 * 100, source: CALCULATOR[size] ? read(MAILPACE, CALCULATOR[size]) : RATE })
const SIZES = [10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000]
const offer: Offer = {
  id: 'mailpace', vendor: 'MailPace', name: 'MailPace', pricing: MAILPACE, checked: CHECKED, unit: 'emails', ladder: 'points',
  counts: 'emails sent and received',
  plans: [{ name: 'Scaling', tiers: SIZES.map(scaling) }],
}

const sizes: Entry['sizes'] = [10_000, 100_000, 1_000_000]
export const mailPace: Entry = {
  slug: 'mailpace',
  vendor: 'MailPace',
  focus: 'developer',
  offer,
  model: { per: 'email' },
  sizes,
  // From 10,000 emails (the first $10 covers them) to 1,000,000, where MailPace's calculator stops.
  steps: SIZES,
  lead: 'MailPace charges $10 a month for the first 10,000 emails, sent or received, and $1 for each 1,000 after that. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, MailPace’s plan: $10 for the first 10,000 emails and $1 for each 1,000 after that. List prices before tax.',
  rows: [
    { short: 'A free allowance for received email', text: `Received email has its own ${formatCount(nightmail.freeReceived)} free a month. MailPace bills it like sent email.`, source: read(MAILPACE, 'Pay only for emails you send or receive … We calculate the amount of emails you\'ve sent/received every billing period and add them onto your bill automatically.') },
    fact('Free every month', `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month.`, 'MailPace’s free plan is up to 100 emails a month, on request.', read(MAILPACE, 'Is there a free trial? Yes! We have a secret free plan. Contact us via email if you\'d like to try us out (up to 100 emails/month).')),
    fact('Campaigns and newsletters', 'Campaigns and newsletters as well as transactional email.', 'MailPace allows transactional email only.', read('https://docs.mailpace.com/', 'MailPace can only be used for Transactional Email . Sending marketing emails, bulk newsletters or other non-transactional content is strictly prohibited.')),
  ],
  // MailPace's readers first see the API, the allowances and receiving.
  panels: ['send', 'free', 'receive', 'campaign', 'agent', 'route', 'domain'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} emails, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
