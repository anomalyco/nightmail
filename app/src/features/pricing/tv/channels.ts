// (With extensions: the build's config imports this file, app/compare-tv.ts.)
import { COMPARISONS } from '../compare/index.ts'
import { claim, dayOf, formatCount, money, nightmailBill, theirPrice, UNITS, type Comparison } from '../prices.ts'

// The comparison pages as channels on the television (features/home/tv), for the prototypes of their redesign (tv/pages.tsx,
// app/compare-tv.ts). Every figure is the price pages' own arithmetic (prices.ts): Nightmail's from the billing code, the
// vendor's from its entry, at a size its page prices (theirPrice), or no figure.

/** The comparisons' three groups, as the hub lists them (the SEO audit's spec for /compare): the developer APIs first (the
 *  homepage's tape compares those), each group in the order compare/index.ts lists it. The channels are numbered in this
 *  order. */
export const GROUPS = [
  { focus: 'developer', id: 'developer', title: 'Developer email APIs' },
  { focus: 'newsletter', id: 'newsletter', title: 'Newsletter and marketing' },
  { focus: 'agents', id: 'agents', title: 'Agent inboxes' },
] as const
export const CHANNELS = GROUPS.flatMap(group => COMPARISONS.filter(c => c.focus === group.focus)).map((comparison, i) => ({ n: i + 1, comparison }))
export const groupOf = (c: Comparison) => GROUPS.find(group => group.focus === c.focus)!
/** The other comparisons of a comparison's group, in channel order. */
export const neighbours = (c: Comparison) => CHANNELS.filter(channel => channel.comparison.focus === c.focus && channel.comparison !== c)
export type Channel = (typeof CHANNELS)[number]
export const channelOf = (slug: string) => CHANNELS.find(channel => channel.comparison.slug === slug)!
/** "CH 01" */
export const chLabel = (n: number) => `CH ${String(n).padStart(2, '0')}`
/** The channel before and after (round the dial: after the last, the first). */
export const around = (n: number) => ({ prev: CHANNELS[(n - 2 + CHANNELS.length) % CHANNELS.length]!, next: CHANNELS[n % CHANNELS.length]! })
/** The set has eight channel keys: they tune to this channel's eight (1-8, 9-16, …), the last bank's spare keys to none. */
export const bankOf = (n: number) => { const first = Math.floor((n - 1) / 8) * 8; return Array.from({ length: 8 }, (_, k) => CHANNELS[first + k] ?? null) }

/** A month at one size, both bills, as the pages print them; theirs null where the vendor's page prices no plan there. */
export type Bill = { size: number; ours: string; theirs: string | null; plan: string | null; oursUc: bigint; theirsCents: number | null }
export function billAt(c: Comparison, size: number): Bill {
  const u = c.use(size), ours = nightmailBill(u.sent, u.received), theirs = theirPrice(c.offer, u)
  return { size, ours: ours.text, oursUc: ours.uc, theirs: theirs ? money(theirs.cents) : null, theirsCents: theirs?.cents ?? null, plan: theirs?.plan ?? null }
}
/** The size a comparison opens at: its middle size, in its own unit. */
export const middle = (c: Comparison) => sizeOf(c, 1)
export const sizeOf = (c: Comparison, i: 0 | 1 | 2) => { const u = c.sizes[i]!; return c.offer.unit === 'contacts' ? u.contacts : c.offer.unit === 'inboxes' ? u.inboxes ?? 0 : c.model.per === 'received' ? u.received : u.sent }
/** What a size is, said in full: "100,000 emails a month", "25,000 contacts", "100 inboxes", "100,000 received a month". */
export const sizeWords = (c: Comparison, size: number) => c.model.per === 'received' ? `${formatCount(size)} emails received a month` : `${formatCount(size)} ${UNITS[c.offer.unit].size}`
/** The OSD's: "PER 100,000 EMAILS". */
export const perWords = (c: Comparison, size: number) => `PER ${formatCount(size)} ${c.model.per === 'received' ? 'RECEIVED' : UNITS[c.offer.unit].head.toUpperCase()}`
export const checkedDay = (c: Comparison) => dayOf(c.offer.checked)
export { claim }

/** The guide's sections (tv/pages.tsx, GuidePage): one per way of counting, each with three sizes as its columns, Nightmail's
 *  row first and then every comparison of that kind from the cheapest at the middle size to the dearest. A vendor with no
 *  price read at a column's size has none there; ranked last at the middle size when it has none. */
export type GuideRow = { channel: Channel; bills: Bill[] }
export type GuideSection = { id: string; title: string; unit: string; columns: number[]; ours: string[]; rows: GuideRow[] }
// (A section's unit is said from its first comparison's usage: every comparison of a kind counts the same way.)
const unitOf = (c: Comparison) => { const m = c.model; return m.per === 'inbox' ? `inboxes, each receiving ${m.receivedPerInbox} and sending ${m.sentPerInbox} emails a month` : m.per === 'contact' ? `contacts, each sent ${m.sendsPerContact} emails a month` : m.per === 'received' ? 'emails received a month' : 'emails sent a month' }
const SECTIONS: { id: string; title: string; columns: number[]; is: (c: Comparison) => boolean }[] = [
  { id: 'sending', title: 'Sending APIs', columns: [10_000, 100_000, 1_000_000], is: c => c.model.per === 'email' },
  { id: 'receiving', title: 'Receiving', columns: [20_000, 100_000, 2_000_000], is: c => c.model.per === 'received' },
  { id: 'agents', title: 'Agent inboxes', columns: [10, 50, 100], is: c => c.model.per === 'inbox' },
  { id: 'newsletters', title: 'Newsletters', columns: [1_000, 10_000, 100_000], is: c => c.model.per === 'contact' },
]
export const GUIDE: GuideSection[] = SECTIONS.map(section => {
  const rows = CHANNELS.filter(channel => section.is(channel.comparison)).map(channel => ({ channel, bills: section.columns.map(size => billAt(channel.comparison, size)) }))
  const mid = (row: GuideRow) => row.bills[1]!.theirsCents ?? Infinity
  rows.sort((a, b) => mid(a) - mid(b) || a.channel.n - b.channel.n)
  // Nightmail's bill at a column is the same whichever comparison it is read from (the usage is the section's).
  const ours = section.columns.map((size, i) => rows[0]!.bills[i]!.ours)
  return { id: section.id, title: section.title, unit: unitOf(rows[0]!.channel.comparison), columns: section.columns, ours, rows }
})
