import { dayOf, fact, formatCount, listOf, readOn, type Entry, type Offer } from '../prices.ts'

// Nightmail vs AgentMail (/compare/agentmail): a comparison's whole entry (prices.ts, Entry). Every figure was read on
// AgentMail's own pricing page (pricing.md is its text) on CHECKED.
const CHECKED = '2026-11-24'
const read = readOn(CHECKED)

const AGENTMAIL = 'https://www.agentmail.to/pricing'
const PLANS = 'https://www.agentmail.to/pricing.md'
const DEVELOPER = '### Developer — $20/month For individual developers. - 10 inboxes - 10,000 emails/month - 1,000 emails/day - 100 emails/5 minutes - 10 GB storage - 10 custom domains - 2 organization seats'
// Past Developer's 10,000 emails AgentMail sells more as an add-on, $2 a month for each 1,000 (its calculator: 25,000
// emails $50, 50,000 $100). Startup's monthly emails: its calculator and docs say 150,000; past that AgentMail names no
// price.
const offer: Offer = {
  id: 'agentmail', vendor: 'AgentMail', name: 'AgentMail', pricing: AGENTMAIL, checked: CHECKED, unit: 'emails', ladder: 'complete',
  counts: 'emails, inboxes, domains and seats', payg: ' plus add-ons',
  beyond: { text: 'Enterprise, custom pricing', source: read(PLANS, '### Enterprise — Custom pricing For tailored solutions. - Everything in Startup tier - Unlimited inboxes available - Bulk discounts') },
  plans: [
    { name: 'Free', note: '100 a day', tiers: [{ size: 3_000, cents: 0, source: read(PLANS, '### Free — $0/month For getting started. - No credit card required - 3 inboxes - 1 custom domain - 3,000 emails/month - 100 emails/day') }] },
    { name: 'Developer', tiers: [{ size: 10_000, cents: 2_000, overage: 200, source: read(PLANS, DEVELOPER), overageSource: read(PLANS, 'Monthly sends: $2/month per 1,000 emails') }] },
    { name: 'Startup', tiers: [{ size: 150_000, cents: 20_000, source: read(AGENTMAIL, 'Your selection: 10 inboxes, 150,000 emails/mo, 10 custom domains. Startup $200/month Startup plan, $200/mo') }] },
  ],
}

const sizes: Entry['sizes'] = [10_000, 50_000, 150_000]
export const agentmail: Entry = {
  slug: 'agentmail',
  vendor: 'AgentMail',
  offer,
  model: { per: 'email' },
  sizes,
  // From 10,000 emails (Developer; up to the free 3,000 both cost $0) to 150,000, Startup's.
  steps: [10_000, 25_000, 50_000, 100_000, 150_000],
  lead: 'AgentMail sells plans by inboxes and emails a month, with add-ons past them. Nightmail charges for each email.',
  assume: 'One recipient each, nothing received, AgentMail’s cheapest plan, or Developer plus email add-ons where that costs less. List prices before tax.',
  rows: [
    fact('Inboxes at no charge', 'No charge per inbox.', 'AgentMail’s Developer plan includes 10 and charges $2 a month for each one after that.', read(PLANS, '- 10 inboxes … Inboxes: $2/month per inbox')),
    fact('Domains at no charge', 'No charge per domain.', 'AgentMail’s Developer plan includes 10 custom domains and charges $2 a month for each one after that.', read(PLANS, '- 10 custom domains … Domains: $2/month per domain')),
    fact('Teammates at no charge', 'No charge for teammates.', 'AgentMail’s Developer plan includes 2 seats and charges $5 a month for each one after that.', read(PLANS, '- 2 organization seats … Seats: $5/month per seat')),
  ],
  // AgentMail's readers first see the agents' inboxes, receiving and the API.
  panels: ['agent', 'receive', 'send', 'free', 'domain', 'team', 'route'],
  description: `Monthly prices at ${listOf(sizes.map(formatCount))} emails, checked ${dayOf(CHECKED)}, and what each one includes.`,
}
