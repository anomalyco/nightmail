import { CREDIT, perThousandUsd, RATES, STORAGE_AFTER_DAYS, usd } from '../../../../api/src/billing/rates.ts'
import type { WorkspaceFocus } from '../../../../api/src/workspace-focus.ts'
import { ALTERNATIVES_VENDORS, PRICING_VENDORS } from './docs/registry.ts'

// The price pages' arithmetic (features/pricing): Nightmail's prices, from the billing code (api/src/billing/rates.ts) so a
// page can't drift from what is billed, and the shape of a competitor's, which each competitor's entry fills in
// (compare/<vendor>.ts, listed in compare/index.ts). Each competitor figure carries the vendor's page, the day it was
// read and the text it was read from. Only figures read on the vendor's own page are in an entry: none is estimated or
// extrapolated, and a size the vendor's page doesn't price, or that wasn't read, shows no number. A figure that fails a
// re-check is removed, not left stale. The build refuses an entry without its sources (entryProblems, below), and
// api/scripts/check-premerge.ts (price pages) checks the pages against the billing code.

/** Where a figure was read: the vendor's page, the day (YYYY-MM-DD) and the text it was read from. */
export type Source = { url: string; checked: string; quote: string }
/** The sources of an entry read on one day: read(url, quote). */
export const readOn = (checked: string) => (url: string, quote: string): Source => ({ url, checked, quote })

/** What the calculator asks: emails sent and received a month, contacts on the list, teammates; and, for a comparison
 *  of agent inboxes, how many inboxes. */
export type Usage = { sent: number; received: number; contacts: number; seats: number; inboxes?: number }
export const MAX_INPUT = 1_000_000_000
/** Any text as a count: digits only, 0 when there are none, at most MAX_INPUT. */
export function count(value: unknown): number {
  const digits = String(value ?? '').replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '').slice(0, 10)
  const n = digits ? Number(digits) : 0
  return Number.isSafeInteger(n) ? Math.min(n, MAX_INPUT) : MAX_INPUT
}

export const formatCount = (n: number) => n.toLocaleString('en-US')
/** Items as a sentence lists them: "a, b and c". */
export const listOf = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items.join('')
/** Whole US cents as micro-cents (1¢ = 1,000,000 µ¢), the billing code's unit. */
export const ucOf = (cents: number) => BigInt(cents) * 1_000_000n
/** A price as the pages print it: the billing code's usd() without the cents of a whole-dollar amount ("$270", "$26.50", "$0"). */
export const price = (uc: bigint) => usd(uc).replace(/\.00$/, '')
export const money = (cents: number) => price(ucOf(cents))
export const dayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

// ---------------------------------------------------------------- Nightmail, from the billing code

export const nightmail = {
  perThousand: `$${perThousandUsd(RATES.emailUc)}`,
  freeSent: RATES.freeSentEmails,
  freeReceived: RATES.freeReceivedEmails,
  storagePerGb: usd(RATES.storageUcPerGbMonth),
  freeStorageGb: Number(RATES.freeStorageBytes / 1_000_000_000n),
  storageAfterDays: STORAGE_AFTER_DAYS,
  minTopUp: money(CREDIT.minTopUpCents),
  expiresAfterMonths: CREDIT.expiresAfterMonths,
}

/** One meter's part of the bill: what was used, what was free, and what it costs. */
export type BillLine = { used: number; free: number; paid: number; uc: bigint; text: string }
/** Nightmail's monthly bill for a usage: (sent − free) and (received − free), each at RATES.emailUc, never below zero. */
export function nightmailBill(sent: number, received: number) {
  const line = (used: number, free: number): BillLine => {
    const paid = Math.max(0, used - free), uc = BigInt(paid) * RATES.emailUc
    return { used, free, paid, uc, text: price(uc) }
  }
  const s = line(sent, RATES.freeSentEmails), r = line(received, RATES.freeReceivedEmails), total = s.uc + r.uc
  return { sent: s, received: r, uc: total, text: price(total) }
}
/** The arithmetic behind one line, as the pages print it. */
export const billMath = (line: BillLine) => line.paid === 0
  ? `${formatCount(line.used)}, within ${formatCount(line.free)} free`
  : `(${formatCount(line.used)} − ${formatCount(line.free)} free) × ${nightmail.perThousand} per 1,000`
/** Paid usage comes from prepaid credit of at least CREDIT.minTopUpCents, which expires: below that a year, the least a year costs. */
export const yearlyFloor = (uc: bigint) => uc > 0n && uc * 12n < ucOf(CREDIT.minTopUpCents) ? nightmail.minTopUp : null

// ---------------------------------------------------------------- competitors priced in tiers

/** size: the units the tier includes (contacts, emails or inboxes). sends, receives, emails: the most emails a month it
 *  allows: sent, received, or both together (only where the vendor's page says it counts both). overage: cents per
 *  1,000 emails past the tier, from its own source when the tier's page doesn't give it. extra: more units sold on top
 *  of the tier, `per` at a time for `cents` each (inboxes: "+$0.40 per additional account"), adding none of its emails. */
export type Tier = {
  size: number; cents: number; sends?: number; receives?: number; emails?: number; overage?: number; overageSource?: Source
  extra?: { per: number; cents: number; name: string; source: Source }
  source: Source
}
export type Plan = {
  name: string
  /** Seats the plan includes (null: unlimited); undefined when the vendor's price doesn't depend on them. label: what the
   *  vendor's page calls them, where that isn't teammates ("additional teammates": besides the account's owner). */
  seats?: { count: number | null; source: Source; label?: string }
  /** The largest size the plan is sold at. */
  max?: { size: number; source: Source }
  /** points: the first tier is also the plan's smallest, so it covers every size below it. */
  startsAtZero?: boolean
  note?: string
  tiers: Tier[]
}
/** How a vendor charges, and the price points read on its page. */
export type Offer = {
  id: string
  vendor: string
  name: string
  /** The vendor's pricing page, and the day its prices were read there (YYYY-MM-DD). */
  pricing: string
  checked: string
  unit: 'contacts' | 'emails' | 'inboxes'
  /** complete: every tier the vendor's page lists, so a size between two is priced at the next one up, as the vendor
   *  does. points: only the sizes that were read; a size between them has no checked price. */
  ladder: 'complete' | 'points'
  /** What the vendor sells past its last tier. */
  beyond?: { text: string; source: Source }
  /** How a smaller tier and its overage is named after the plan, in the vendor's words: ", pay as you go" (the default),
   *  " plus overage". */
  payg?: string
  counts: string
  plans: Plan[]
}

export type Quote =
  | { kind: 'price'; plan: Plan; tier: Tier; cents: number; extra: number; payg: { plan: Plan; tier: Tier; buckets: number; cents: number } | null }
  | { kind: 'unpublished'; text: string; source: Source }
  | { kind: 'unchecked' }

export const offerSize = (offer: Offer, u: Usage) => offer.unit === 'contacts' ? u.contacts : offer.unit === 'inboxes' ? u.inboxes ?? 0 : u.sent + u.received
type Fit = { tier: Tier; cents: number; extra: number } | 'no' | 'unknown'
// The tier a plan would sell for a usage, as the vendor's page states it: its cheapest tier that holds the size (with
// the extra units it sells on top, where it does), the emails and the seats. On a 'points' offer only a size that was
// read (or one below a plan's smallest tier) has one, and when that tier's sends are too few, the bigger tier that would
// hold them wasn't read.
function fit(offer: Offer, plan: Plan, size: number, u: Usage): Fit {
  if (plan.seats && plan.seats.count !== null && u.seats > plan.seats.count) return 'no'
  if (plan.max && size > plan.max.size) return 'no'
  const holds = (t: Tier) => (t.sends === undefined || u.sent <= t.sends) && (t.receives === undefined || u.received <= t.receives) && (t.emails === undefined || u.sent + u.received <= t.emails)
  if (offer.ladder === 'complete') {
    const options = plan.tiers.filter(holds).flatMap(tier => {
      if (tier.size >= size) return [{ tier, cents: tier.cents, extra: 0 }]
      if (!tier.extra) return []
      const packs = Math.ceil((size - tier.size) / tier.extra.per)
      return [{ tier, cents: tier.cents + packs * tier.extra.cents, extra: packs * tier.extra.per }]
    })
    return options.sort((a, b) => a.cents - b.cents)[0] ?? 'no'
  }
  const at = plan.tiers.find(t => t.size === size) ?? (plan.startsAtZero && size <= plan.tiers[0]!.size ? plan.tiers[0] : undefined)
  if (!at) return 'unknown'
  if (holds(at)) return { tier: at, cents: at.cents, extra: 0 }
  return plan.max?.size === at.size ? 'no' : 'unknown'
}
/** A vendor's price for a usage: its cheapest plan that holds it, when every plan's answer is known. */
export function quote(offer: Offer, u: Usage): Quote {
  const size = offerSize(offer, u)
  const fits = offer.plans.map(plan => ({ plan, fit: fit(offer, plan, size, u) }))
  const priced = fits.flatMap(({ plan, fit }) => typeof fit === 'object' ? [{ plan, ...fit }] : []).sort((a, b) => a.cents - b.cents)
  const best = priced[0]
  // A $0 plan is the cheapest whatever the unknowns cost; otherwise an unknown plan might be cheaper.
  if (best && (best.cents === 0 || !fits.some(f => f.fit === 'unknown'))) return { kind: 'price', plan: best.plan, tier: best.tier, cents: best.cents, extra: best.extra, payg: payg(offer, size, best.cents) }
  if (!best && offer.beyond && fits.every(f => f.fit === 'no')) return { kind: 'unpublished', ...offer.beyond }
  return { kind: 'unchecked' }
}
// Opting into pay-as-you-go instead: a smaller paid tier plus its overage buckets, when that costs less. Only within the
// sizes the vendor's tiers reach: past them its page names no price.
function payg(offer: Offer, size: number, price: number) {
  let found: { plan: Plan; tier: Tier; buckets: number; cents: number } | null = null
  if (offer.ladder !== 'complete' || size > Math.max(...offer.plans.flatMap(plan => plan.tiers.map(t => t.size)))) return null
  for (const plan of offer.plans) for (const tier of plan.tiers) {
    if (tier.overage === undefined || tier.size >= size) continue
    const buckets = Math.ceil((size - tier.size) / 1000), total = tier.cents + buckets * tier.overage
    if (total < price && (!found || total < found.cents)) found = { plan, tier, buckets, cents: total }
  }
  return found
}

const paygName = (offer: Offer, plan: Plan) => `${plan.name}${offer.payg ?? ', pay as you go'}`
/** A plan as the price names it: with the extra units bought on top ("Pro + 950 accounts"). */
const planName = (q: Extract<Quote, { kind: 'price' }>) => q.extra ? `${q.plan.name} + ${formatCount(q.extra)} ${q.tier.extra!.name}` : q.plan.name

/** A vendor's line on the calculator's board, as a buyer would pay it: its cheapest plan that holds the numbers, or
 *  pay-as-you-go where that costs less. Vendors with no price read for the numbers have none. */
export type VendorRow = { offer: Offer; plan: string; cents: number }
export function vendorRows(offers: readonly Offer[], u: Usage): VendorRow[] {
  return offers.flatMap(offer => {
    if (offer.unit === 'contacts' && u.contacts === 0) return []
    const q = quote(offer, u)
    if (q.kind !== 'price') return []
    if (q.payg) return [{ offer, plan: paygName(offer, q.payg.plan), cents: q.payg.cents }]
    return [{ offer, plan: offer.unit === 'contacts' && offer.name.endsWith(' marketing') && !/marketing/i.test(q.plan.name) ? `${q.plan.name} marketing` : planName(q), cents: q.cents }]
  })
}

// ---------------------------------------------------------------- the pages' comparisons and disclosures

/** The facts every price page can list, written once in page/facts.ts. */
export type SharedFact = 'free' | 'domains' | 'contacts' | 'teammates' | 'campaigns' | 'agents'
/** A row as a line of a page's facts list (page/facts.ts): a plain statement about Nightmail, or one of the shared
 *  facts the row comes down to. */
export type Line = string | { shared: SharedFact } | { text: string; brief: string }
/** short: the same claim in a few words, for a list that is scanned; note: what stands behind it, in a line; line: the
 *  row in a page's facts list, where its first sentence alone wouldn't read as plain words (or says a shared fact). */
export type Fact = { text: string; short?: string; note?: string; line?: Line | Line[]; source: Source }
/** One of the comparison's rows: what Nightmail has that the competitor charges for or lacks, with the competitor's page
 *  where it says so (a row that names only Nightmail's own terms has no source). */
export type Row = Fact | { text: string; short?: string; note?: string; line?: Line | Line[]; source?: undefined }
/** A claim about Nightmail and the competitor's own page for the other half of it: text is the two sentences together. */
export const fact = (short: string, ours: string, note: string, source: Source, line?: Line | Line[]): Fact => ({ short, note, text: `${ours} ${note}`, ...line === undefined ? {} : { line }, source })

/** The panels of "Also in the box" (panels.ts, features.tsx), in a comparison's reading order. */
export type PanelId = 'send' | 'campaign' | 'contacts' | 'team' | 'free' | 'receive' | 'agent' | 'route' | 'domain' | 'ready' | 'hygiene'
/** How many panels a comparison shows: the wall's slots (features.tsx). */
export const PANEL_SLOTS = 7

/** One competitor, as its comparison page (/compare/<slug>) and everything made from it say: the page, its Markdown
 *  twin, its line in llms.txt, its sitemap entry and its structured data (app/price-pages.ts). A new comparison is one
 *  of these in compare/<slug>.ts, listed in compare/index.ts; its link-preview card is drawn from its data (pages.ts). */
export type Entry = {
  /** The page's address: /compare/<slug>. */
  slug: string
  vendor: string
  /** Another name buyers search the vendor by, beside it in the search result's title and description (searchWords). */
  aka?: string
  /** Who the page is for, as onboarding asks it (api/src/workspace-focus.ts): its Get started signs in with ?focus=. */
  focus: WorkspaceFocus
  /** How the vendor charges and its price points, each with its source. */
  offer: Offer
  /** The usage both prices are for at a size on the fader: so many emails to every contact a month, with this many
   *  teammates; emails sent, one recipient each; emails received, nothing sent; or so many emails received and sent by
   *  every inbox a month. */
  model: { per: 'contact'; sendsPerContact: number; seats: number } | { per: 'email' } | { per: 'received' } | { per: 'inbox'; receivedPerInbox: number; sentPerInbox: number }
  /** Small, medium and large, in the offer's unit: the page opens at the middle one. */
  sizes: [number, number, number]
  /** The sizes the page's fader can reach, each one the vendor prices and Nightmail costs less at (the pre-merge check
   *  proves both). On a 'complete' ladder a typed size between the first and the last is priced too (reachable). */
  steps: number[]
  /** How each one charges, in two sentences (the Markdown twin's summary), and the line under the board: the usage
   *  both prices are for. */
  lead: string
  assume: string
  rows: Row[]
  /** The panels of "Also in the box", in reading order: the first is the lead. */
  panels: PanelId[]
  /** What the vendor's buyer may count on that Nightmail doesn't do ("signup forms", "a web archive"): said on the page
   *  and in its twin as "Not in the box", so a comparison on price doesn't stand in for one on features. */
  without?: string[]
  /** What the vendor offers that Nightmail doesn't (up to five), each read on the vendor's own page: an alternatives
   *  page's Markdown copy says them (docs/alternatives.ts, gapsSection). */
  gaps?: Gap[]
}
/** Something a vendor offers that Nightmail doesn't, in the vendor's own terms. Each is two claims: the vendor's page says
 *  it has it (source), and Nightmail doesn't, checked against its API reference, dashboard and billing code (the pull
 *  request that adds it says where). The build stops on one without its source (entryProblems) and on one whose subject a
 *  "With Nightmail" fact, an "Also in the box" panel or the comparison's own lines name (docs/index.ts, docProblems). */
export type Gap = {
  /** A few words for a list: "dedicated IPs". */
  what: string
  /** The line, as the vendor's page puts it: what it is, and on which plans or at what price where the page says. */
  text: string
  /** The words a Nightmail fact naming the same thing would use. */
  subject: RegExp
  source: Source
  /** Nightmail's half, only where the bare line would mislead about Nightmail: "Nightmail sells no dedicated IPs.", and
   *  a libraries line's "Nightmail’s SDK is for TypeScript." No line closes with a general "Nightmail has none": the
   *  question or the section's title says it. */
  ours?: string
}
export const gap = (what: string, text: string, subject: RegExp, source: Source, ours?: string): Gap => ({ what, text, subject, source, ...ours ? { ours } : {} })
/** Nightmail's half of a dedicated-IP line, the same for every vendor. */
export const NO_DEDICATED_IP = 'Nightmail sells no dedicated IPs.'
/** Nightmail's half of a libraries line: what it does have (sdk/, @nightmail/sdk, "TypeScript SDK for the Nightmail email
 *  API"), so the line doesn't read as "no libraries". */
export const TYPESCRIPT_SDK = 'Nightmail’s SDK is for TypeScript.'
/** The days a page's prices were read, as its caption says them: "25 Nov 2026", or a span, "25–26 Nov 2026" (one month)
 *  or "30 Nov to 1 Dec 2026". Shared by the pages of several services. */
export function checkedOn(days: string[]) {
  const sorted = [...new Set(days)].sort(), first = sorted[0]!, last = sorted.at(-1)!
  if (first === last) return dayOf(first)
  const [a, b] = [dayOf(first).split(' '), dayOf(last).split(' ')]
  return a[1] === b[1] && a[2] === b[2] ? `${a[0]}–${dayOf(last)}` : a[2] === b[2] ? `${a[0]} ${a[1]} to ${dayOf(last)}` : `${dayOf(first)} to ${dayOf(last)}`
}
/** Subjects several vendors' gaps share. */
export const LANGUAGES = /\b(?:Python|Ruby|PHP|Java|Rust|C#|Golang)\b|\.NET\b|\b(?:libraries|SDKs) for\b/
export const AUTOMATION = /\bautomat(?:ion|ions|ed|es|e)\b|\bworkflows?\b|\bdrip\b/i
/** Words that judge rather than describe; a gap says what a thing is (Ryan: no "better", "more mature", "enterprise-grade"). */
export const JUDGEMENT = /\b(?:better|best|more mature|mature|enterprise-grade|leading|superior|powerful|robust|reliable|world-class|advanced|premium|seamless)\b/i
/** At most this many gaps a vendor. */
export const MAX_GAPS = 5
/** An entry as the pages use it: with its three sizes and each fader size as the usage both prices are for, and its
 *  search result's title and description (searchWords). */
export type Comparison = Omit<Entry, 'sizes'> & {
  title: string
  searchTitle: string
  description: string
  path: string
  sizes: Usage[]
  use: (size: number) => Usage
}
export function comparisonOf(entry: Entry): Comparison {
  const m = entry.model
  const use = m.per === 'contact'
    ? (contacts: number): Usage => ({ contacts, sent: contacts * m.sendsPerContact, received: 0, seats: m.seats })
    : m.per === 'inbox'
      ? (inboxes: number): Usage => ({ inboxes, contacts: 0, sent: inboxes * m.sentPerInbox, received: inboxes * m.receivedPerInbox, seats: 1 })
      : m.per === 'received'
        ? (received: number): Usage => ({ contacts: 0, sent: 0, received, seats: 1 })
        : (sent: number): Usage => ({ contacts: 0, sent, received: 0, seats: 1 })
  const sizes = entry.sizes.map(use)
  return { ...entry, title: `Nightmail vs ${entry.vendor}`, ...searchWords(entry, sizes[1]!), path: `/compare/${entry.slug}`, sizes, use }
}
/** The board's opening size as a sentence names it, with both monthly prices, the competitor's plan and the day its
 *  prices were read: what the search result's description (searchWords) and the Markdown twin's summary quote. */
export function opening(entry: Pick<Entry, 'offer' | 'model'>, u: Usage) {
  const m = entry.model, theirs = theirPrice(entry.offer, u)!
  const size = m.per === 'contact' ? `${formatCount(u.contacts)} contacts emailed ${m.sendsPerContact} times a month`
    : m.per === 'inbox' ? `${formatCount(u.inboxes ?? 0)} agent inboxes, each ${m.receivedPerInbox} in and ${m.sentPerInbox} out a month`
      : m.per === 'received' ? `${formatCount(u.received)} emails received a month` : `${formatCount(u.sent)} emails a month`
  return { size, theirs: money(theirs.cents), plan: theirs.plan, ours: nightmailBill(u.sent, u.received).text, day: dayOf(entry.offer.checked) }
}
/** The first of `texts` from `min` to `max` characters long, else the first at most `max`, else the last: a title (60) or a
 *  description (160) from the longest way of saying it to the shortest. */
export const fitWords = (texts: string[], max: number, min = 0) => texts.find(text => text.length <= max && text.length >= min) ?? texts.find(text => text.length <= max) ?? texts.at(-1)!
/** A comparison's title and description in search results and link previews, made from its data: led by what someone
 *  types ("<vendor> alternative", "<vendor> pricing"), then the board's opening size with both monthly prices and the day
 *  the vendor's were read, and how the vendor charges (its lead's first sentence) or what else the page has. A search
 *  the vendor's own page answers (docs/registry.ts) is left to it: with a pricing page (/pricing/<slug>) the comparison
 *  drops "pricing" and keeps "alternative" ("<vendor> alternative: Nightmail vs <vendor>"); with an alternatives page
 *  as well, it is the head-to-head ("Nightmail vs <vendor>: price at every size"). The title fits 60 characters and the
 *  description 160 (price-pages.ts checks both): the first of these that fits. */
function searchWords(entry: Entry, u: Usage): { searchTitle: string; description: string } {
  const { vendor } = entry, { size, theirs, plan, ours, day } = opening(entry, u)
  const named = entry.aka ? `${vendor} (${entry.aka})` : vendor, how = entry.lead.split(/(?<=\.) /)[0]!
  const pricing = PRICING_VENDORS.includes(entry.slug), alternatives = ALTERNATIVES_VENDORS.includes(entry.slug)
  const sideBySide = (head: string) => [
    `${head} (${plan}), Nightmail ${ours}. Every size ${vendor} prices, side by side.`, `${head}, Nightmail ${ours}. Every size ${vendor} prices, side by side.`,
    `${head} (${plan}), Nightmail ${ours}. ${how}`, `${head}, Nightmail ${ours}. ${how}`, `${head}, Nightmail ${ours}. Both prices at every size.`, `${head}, Nightmail ${ours}.`,
  ]
  if (pricing && !alternatives) return {
    searchTitle: fitWords([`${named} alternative: Nightmail vs ${vendor}`, `${vendor} alternative: Nightmail vs ${vendor}`, `${vendor} alternative · Nightmail`], 60),
    description: fitWords(sideBySide(`${named} alternative, checked ${day}: at ${size}, ${vendor} ${theirs}`), 160, 140),
  }
  if (pricing) {
    const head = `Nightmail vs ${named}, checked ${day}: at ${size}, ${vendor} ${theirs}`
    return { searchTitle: fitWords([`Nightmail vs ${vendor}: price at every size`, `Nightmail vs ${vendor}`], 60), description: fitWords(sideBySide(head), 160, 140) }
  }
  const title = `${named} alternative: Nightmail vs ${vendor} pricing`, head = `${named} pricing vs Nightmail, checked ${day}: ${size}, `
  const prices = [`${head}${vendor} ${theirs} (${plan}), Nightmail ${ours}.`, `${head}${vendor} ${theirs}, Nightmail ${ours}.`]
  const words = [...prices.map(text => `${text} ${how}`), ...prices.map(text => `${text} See every size and what each includes.`), ...prices]
  return { searchTitle: fitWords([title, `${named} alternative and pricing · Nightmail`], 60), description: fitWords(words, 160) }
}
/** A comparison's unit as its page names it: the fader's label, the board's head and a size in a sentence. */
export const UNITS = {
  contacts: { label: 'Contacts', head: 'contacts', size: 'contacts' },
  emails: { label: 'Emails', head: 'emails', size: 'emails a month' },
  inboxes: { label: 'Inboxes', head: 'inboxes', size: 'inboxes' },
} as const
/** The usage both prices are for at a size, as the board's foot says it: the emails a month and how they're made up. */
export function usageLines(c: Pick<Comparison, 'model'>, u: Usage): string[] {
  const m = c.model
  if (m.per === 'contact') return [`${formatCount(u.sent)} emails a month`, `${m.sendsPerContact} to each contact`]
  if (m.per === 'received') return [`${formatCount(u.received)} received and 0 sent a month`, 'Delivered to your app']
  if (m.per === 'inbox') return [`${formatCount(u.received)} received and ${formatCount(u.sent)} sent a month`, `${m.receivedPerInbox} in and ${m.sentPerInbox} out per inbox`]
  return ['One recipient each', 'Nothing received']
}
/** Every source an entry cites: its price points, its plans' limits and its rows. */
export const sourcesOf = (entry: Pick<Entry, 'offer' | 'rows'>): Source[] => [
  ...entry.offer.plans.flatMap(plan => [...plan.tiers.flatMap(tier => [tier.source, ...tier.overageSource ? [tier.overageSource] : [], ...tier.extra ? [tier.extra.source] : []]), ...plan.seats ? [plan.seats.source] : [], ...plan.max ? [plan.max.source] : []]),
  ...entry.offer.beyond ? [entry.offer.beyond.source] : [], ...entry.rows.flatMap(row => row.source ? [row.source] : []),
]
/** A script or data file a vendor's pricing page reads its prices from (Postmark's pricing.<hash>.js, Ghost's
 *  pricing.min.js): where the figures were read, but not a page a person opens, and its address changes when the vendor
 *  deploys. (A PDF, a Markdown page or an llms.txt is text a person can read.) */
export const isDataFile = (url: string) => /\.(?:m?js|json|csv|xml)$/i.test(new URL(url).pathname)
/** The sources a page shows a visitor, in its note or its list of pages read: a data file is shown as the vendor's
 *  pricing page it belongs to, read the same day. The entry keeps it, and the Markdown copies name it (sourceNote). */
export const shownSources = (sources: Source[], offer: Pick<Offer, 'pricing'>): Source[] =>
  sources.map(source => isDataFile(source.url) && !isDataFile(offer.pricing) ? { ...source, url: offer.pricing } : source)
/** What a Markdown copy says after a source that is a data file. */
export const sourceNote = (url: string) => isDataFile(url) ? ' (the pricing page’s own price data)' : ''
/** The last day any of an entry's figures was read: when its page last changed (the sitemap's lastmod). */
export const lastChecked = (entry: Pick<Entry, 'offer' | 'rows'>) => [entry.offer.checked, ...sourcesOf(entry).map(source => source.checked)].sort().at(-1)!
/** The tier sizes an offer's page lists from `from` to `to`, in order: a fader's usual steps. */
export const tierSizes = (offer: Offer, from: number, to: number) =>
  [...new Set(offer.plans.flatMap(plan => plan.tiers.map(tier => tier.size)))].filter(size => size >= from && size <= to).sort((a, b) => a - b)

/** A competitor's price for a usage as a buyer would pay it: its cheapest plan, or pay-as-you-go where that costs less. */
export function theirPrice(offer: Offer, u: Usage): { cents: number; plan: string } | null {
  const q = quote(offer, u)
  if (q.kind !== 'price') return null
  return q.payg ? { cents: q.payg.cents, plan: paygName(offer, q.payg.plan) } : { cents: q.cents, plan: planName(q) }
}
/** Every size the control can show: its steps, and on a 'complete' ladder every 1,000 between the first and the last
 *  (every inbox, for inboxes). */
export function reachable(c: Comparison): number[] {
  if (c.offer.ladder !== 'complete') return c.steps
  const first = c.steps[0]!, last = c.steps.at(-1)!, grid = new Set(c.steps), unit = c.offer.unit === 'inboxes' ? 1 : 1000
  for (let size = Math.ceil(first / unit) * unit; size <= last; size += unit) grid.add(size)
  return [...grid].sort((a, b) => a - b)
}
/** The page's headline: the gap as it holds at every size the control can reach, up to 20 times. */
export function claim(c: Comparison): string {
  const least = Math.min(...reachable(c).map(size => {
    const u = c.use(size), ours = nightmailBill(u.sent, u.received).uc, theirs = ucOf(theirPrice(c.offer, u)!.cents)
    return ours === 0n ? Infinity : Number(theirs) / Number(ours)
  }))
  if (!Number.isFinite(least)) return `Nightmail costs less than ${c.offer.vendor}`
  // Past 20 times the figure says more about Nightmail's free allowance than about either price (agent inboxes that
  // receive within it), so the headline says no more than 20.
  if (least > 20) return `${c.offer.vendor} costs at least 20\u00a0times as much as Nightmail`
  if (least >= 2) return `${c.offer.vendor} costs ${Number.isInteger(least) ? 'at least' : 'over'} ${Math.floor(least)}\u00a0times as much as Nightmail`
  return `Nightmail costs less than ${c.offer.vendor}`
}

/** What's wrong with an entry, as the build reports it (app/price-pages.ts): every competitor figure and row must carry
 *  its source (an https page, the day it was read, not after `today`, and the text it was read from), and the page
 *  needs its address, sizes, steps and panels. Empty when the entry can ship. */
export function entryProblems(entry: Entry, today: string, panels: readonly string[]): string[] {
  const problems: string[] = [], day = /^\d{4}-\d{2}-\d{2}$/
  const at = (where: string, problem: string) => problems.push(`${entry.slug || '(no slug)'}: ${where} ${problem}`)
  const checkSource = (where: string, source: Source | undefined) => {
    if (!source) return at(where, 'has no source.')
    let url: URL | null = null
    try { url = new URL(source.url) } catch { url = null }
    if (url?.protocol !== 'https:') at(where, `has no https link to the vendor's page (${source.url}).`)
    if (!day.test(source.checked) || Number.isNaN(Date.parse(source.checked)) || source.checked > today) at(where, `has no valid day it was checked (YYYY-MM-DD, not after ${today}): ${source.checked}.`)
    if (typeof source.quote !== 'string' || source.quote.trim().length < 8) at(where, 'doesn’t quote the text it was read from.')
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug)) at('slug', 'must be lowercase letters, digits and hyphens.')
  if (!entry.vendor.trim()) at('vendor', 'is empty.')
  if (!day.test(entry.offer.checked) || entry.offer.checked > today) at('offer.checked', `must be a day (YYYY-MM-DD) not after ${today}.`)
  try { if (new URL(entry.offer.pricing).protocol !== 'https:') at('offer.pricing', 'must be the vendor’s https pricing page.') } catch { at('offer.pricing', 'must be the vendor’s https pricing page.') }
  if (!entry.offer.plans.length) at('offer.plans', 'lists no plans.')
  entry.offer.plans.forEach((plan, p) => {
    if (!plan.tiers.length) at(`offer.plans[${p}] (${plan.name})`, 'lists no price points.')
    plan.tiers.forEach((tier, t) => {
      checkSource(`offer.plans[${p}].tiers[${t}] (${plan.name} at ${tier.size})`, tier.source)
      if (tier.overageSource) checkSource(`offer.plans[${p}].tiers[${t}].overageSource`, tier.overageSource)
      if (tier.extra) checkSource(`offer.plans[${p}].tiers[${t}].extra`, tier.extra.source)
    })
    if (plan.seats) checkSource(`offer.plans[${p}].seats`, plan.seats.source)
    if (plan.max) checkSource(`offer.plans[${p}].max`, plan.max.source)
  })
  if (entry.offer.beyond) checkSource('offer.beyond', entry.offer.beyond.source)
  entry.rows.forEach((row, r) => {
    // A row that names the competitor says something about it: it needs the page that says so. (One that doesn't is
    // about Nightmail alone, such as its own price for received mail.)
    if (row.source || row.text.includes(entry.vendor)) checkSource(`rows[${r}] (${row.short ?? row.text.slice(0, 40)})`, row.source)
  })
  if (!entry.rows.length) at('rows', 'is empty: the page lists what Nightmail has that the competitor charges for or lacks.')
  if ((entry.gaps?.length ?? 0) > MAX_GAPS) at('gaps', `lists ${entry.gaps!.length}: at most ${MAX_GAPS}.`)
  entry.gaps?.forEach((item, i) => {
    checkSource(`gaps[${i}] (${item.what})`, item.source)
    if (!item.what.trim() || !item.text.trim()) at(`gaps[${i}]`, 'needs a few words and a line.')
    if (JUDGEMENT.test(item.what) || JUDGEMENT.test(item.text) || JUDGEMENT.test(item.ours ?? '')) at(`gaps[${i}] (${item.what})`, `judges ("${(item.what + ' ' + item.text).match(JUDGEMENT)![0]}"): say what it is, in the vendor's terms.`)
  })
  if (entry.sizes.length !== 3 || entry.sizes.some(size => !(size > 0))) at('sizes', 'must be three sizes above zero.')
  if (entry.steps.length < 2 || entry.steps.some((size, i) => i > 0 && size <= entry.steps[i - 1]!)) at('steps', 'must be at least two sizes, smallest first.')
  if (entry.panels.length !== PANEL_SLOTS || new Set(entry.panels).size !== PANEL_SLOTS || entry.panels.some(id => !panels.includes(id))) at('panels', `must be ${PANEL_SLOTS} different panels of ${panels.join(', ')}.`)
  return problems
}
