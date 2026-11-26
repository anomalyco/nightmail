import { ENTRIES } from '../../pricing/compare/index.ts'
import { dayOf, listOf, nightmail, nightmailBill, theirPrice, type Usage } from '../../pricing/prices.ts'

// The figures the homepage's television plays (tv.tsx): what a month of sending costs on Nightmail and on the vendors a developer compares
// it with, at one volume. Every figure comes from the price pages' own arithmetic (pricing/prices.ts): Nightmail's from
// the billing code, a vendor's from its comparison entry (pricing/compare/<slug>.ts), read on the vendor's pricing page.

/** Emails sent a month, the sizes a page steps through. Nightmail costs less than every rival at each of them, and at
 *  every size between the first and the last. */
export const VOLUMES = [10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000] as const
export type Volume = (typeof VOLUMES)[number]
/** The size a page opens on. */
export const OPENING: Volume = 100_000
export const MIN_VOLUME = VOLUMES[0], MAX_VOLUME = VOLUMES[VOLUMES.length - 1]!

const SLUGS = ['resend', 'sendgrid', 'postmark', 'mailgun', 'mailersend', 'smtp2go'] as const
export type RivalSlug = (typeof SLUGS)[number]
export type Rival = {
  slug: RivalSlug
  /** The vendor's name, as plain text: no logos or marks. */
  name: string
  /** Its full comparison page, /compare/<slug>. */
  path: string
  /** The vendor's own pricing page, and the day its prices were read there ("25 Nov 2026"). */
  pricing: string
  checked: string
}
const entries = SLUGS.map(slug => ENTRIES.find(entry => entry.slug === slug)!)
export const RIVALS: Rival[] = entries.map(entry => ({ slug: entry.slug as RivalSlug, name: entry.vendor, path: `/compare/${entry.slug}`, pricing: entry.offer.pricing, checked: dayOf(entry.offer.checked) }))

const usage = (emails: number): Usage => ({ sent: Math.round(emails), received: 0, contacts: 0, seats: 1 })

/** Nightmail's bill in dollars for a month of `emails` sent: the first 5,000 free, then $0.20 per 1,000. */
export const nightmailDollars = (emails: number) => Number(nightmailBill(usage(emails).sent, 0).uc) / 1e8
/** A rival's bill in dollars for the same month: its cheapest plan that holds the volume, or pay-as-you-go where that
 *  costs less, and the plan's name. Any volume from MIN_VOLUME to MAX_VOLUME has one. */
export function rivalPrice(slug: RivalSlug, emails: number): { dollars: number; plan: string } {
  const price = theirPrice(entries[SLUGS.indexOf(slug)]!.offer, usage(emails))
  if (!price) throw new Error(`${slug} has no price read at ${emails} emails`)
  return { dollars: price.cents / 100, plan: price.plan }
}

export type Line = { slug: RivalSlug | 'nightmail'; name: string; ours: boolean; dollars: number; plan: string | null; path: string | null }
/** One month at a volume: Nightmail first, then the rivals from the cheapest to the dearest. */
export function month(emails: number): Line[] {
  const rivals = RIVALS.map(rival => ({ slug: rival.slug, name: rival.name, ours: false, ...rivalPrice(rival.slug, emails), path: rival.path }))
  return [{ slug: 'nightmail', name: 'Nightmail', ours: true, dollars: nightmailDollars(emails), plan: null, path: null }, ...rivals.sort((a, b) => a.dollars - b.dollars)]
}
/** Every step of VOLUMES, worked out once. */
export const MONTHS: Record<Volume, Line[]> = Object.fromEntries(VOLUMES.map(volume => [volume, month(volume)])) as Record<Volume, Line[]>

/** "$19", "$19.95", "$1,150": no cents on a whole-dollar amount. */
export const usd = (dollars: number) => `$${dollars.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2, maximumFractionDigits: 2 })}`
/** "100,000" */
export const count = (n: number) => n.toLocaleString('en-US')
/** "10k", "250k", "1M": a volume where there is little room. */
export const short = (n: number) => n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${+(n / 1_000).toFixed(0)}k`

/** Nightmail's own terms, from the billing code. */
export const PER_THOUSAND = nightmail.perThousand
export const FREE_SENT = nightmail.freeSent
export const FREE_RECEIVED = nightmail.freeReceived

/** What both prices are for: the line a page's figures stand on, said once, quietly, near the sources. */
export const ASSUME = 'One recipient each, nothing received. Each vendor’s cheapest plan that holds the volume, or pay-as-you-go where that costs less. List prices before tax, monthly billing.'
/** "Prices read on Resend’s, … and SMTP2GO’s pricing pages on 25 Nov 2026." The names link to RIVALS[].pricing. */
export const CHECKED = [...new Set(RIVALS.map(rival => rival.checked))]
export const SOURCES = `Prices read on each vendor’s own pricing page on ${listOf(CHECKED)}.`
/** The price pages' own notice (pricing/index.tsx): a page that names other vendors carries it at its foot. */
export const NOTICE = 'Product names belong to their owners and only identify their products. Nightmail isn’t affiliated with them.'
