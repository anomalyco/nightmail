// (With extensions: the build's config imports this file, through pages.ts.)
import { productName, publicOrigin } from '../../../../../api/src/brand.ts'
import { checkedOn, dayOf, fitWords, formatCount, listOf, money, nightmail, quote, shownSources, type Comparison, type Source } from '../prices.ts'
import { billAt, groupOf, ORDERED, perSize } from '../page/comparison.ts'
import { briefFactsSection, rowLines } from '../page/facts.ts'
import { comparisonQuestions } from '../questions.ts'
import { folded, pageName, plain, type Doc, type Section, type Table, type Text } from './doc.ts'

// A vendor's alternatives page (/alternatives/<slug>, "SendGrid alternatives"): Nightmail's price and the others' at the
// vendor's own three sizes, Get started, and one table (Ryan: "headline, button, comparison underneath"): Nightmail's row
// first, the vendor's as the reference, then the lowest-priced services that count the same way (its comparison's
// group: developer sending, or newsletters by contact), each linked to its comparison. Then the facts every price page
// lists, and its pages. What it says of Nightmail is the one claim the data shows: it costs less than each service listed,
// at every size shown, which the build checks for every service the page or its Markdown copy prices, and stops where it
// isn't so. The assumptions, the pages read, the services left off the table and what the vendor has that Nightmail
// doesn't are in the Markdown copy. Made from the comparisons' data alone (compare/<slug>.ts), so a vendor in the registry
// (registry.ts, ALTERNATIVES_VENDORS) is a page.

/** Services on the page's table besides Nightmail and the vendor: the lowest of those with a price read at the middle size, so the table stays
 *  one calm table on a phone (eight rows, four columns). The rest are in the Markdown copy. */
export const SHOWN_OTHERS = 6

/** "Nov 2026", for a title. */
/** A small count in words, as a caption says it: "six alternatives". */
/** Under a table, what a dash means: no price was read for that size (a service may still sell one: Bird's deposit plan at
 *  10,000). One sentence for every page of several services, so they can't drift. */
export { checkedOn }
export const DASH = ' A dash: no price read for that size.'

/** What a vendor offers that Nightmail doesn't (its entry's gaps), as a section of a page's Markdown copy: each line in the
 *  vendor's own terms, linked to the page it was read on, under the days they were read. One generator, so the copy,
 *  its twin and llms-full.txt say the same. */
export function gapsSection(c: Comparison): Section {
  const vendor = c.offer.vendor, gaps = c.gaps ?? []
  return { id: 'gaps', title: `What ${vendor} has that ${productName} does not`, blocks: [
    { kind: 'p', text: [`Read on ${vendor}’s own pages, ${checkedOn(gaps.map(item => item.source.checked))}.`] },
    { kind: 'list', items: gaps.map(item => [`${item.text}${item.ours ? ` ${item.ours}` : ''} (`, { text: pageName(item.source.url), href: item.source.url }, ')']) },
  ] }
}
/** The same, as one line: "Not in Nightmail: dedicated IPs, …". */
export const gapsLine = (c: Comparison) => `Not in ${productName}: ${listOf((c.gaps ?? []).map(item => item.what))}.`
export const spelled = (n: number) => ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n)
export const month = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })

export function vendorAlternatives(c: Comparison): Doc {
  const vendor = c.offer.vendor, m = c.model, sizes = c.sizes.map(u => c.offer.unit === 'contacts' ? u.contacts : u.sent)
  const at = (o: Comparison) => sizes.map(size => billAt(o, size))
  // Every service that counts the way the vendor's comparison does, in its group: the Markdown copy's table, by price at
  // the middle size (a service with none there last).
  const group = ORDERED.filter(o => o.focus === c.focus && o.model.per === m.per).map(o => ({ o, bills: at(o) }))
  const mid = (row: (typeof group)[number]) => row.bills[1]!.theirsCents ?? Infinity
  group.sort((a, b) => mid(a) - mid(b))
  const ours = at(c)
  // Ryan's rule (A294): the page says Nightmail costs less than each service it lists at every size shown. The build stops
  // where that isn't so, for every priced cell of the Markdown copy's table, which holds the page's.
  for (const { o, bills } of group) for (const b of bills) if (b.theirsCents !== null && !(b.oursUc < BigInt(b.theirsCents) * 1_000_000n))
    throw new Error(`/alternatives/${c.slug} would show Nightmail at ${b.ours} and ${o.offer.vendor} at ${b.theirs} for ${perSize(c, b.size).replace(/^Per /, '')}: Nightmail must cost less than each service at every size shown (docs/alternatives.ts).`)
  const self = group.find(row => row.o === c)!, priced = group.filter(row => row.o !== c && row.bills[1]!.theirsCents !== null)
  // (priced is in the order of the middle size's price, the group's order breaking a tie.)
  const shown = priced.slice(0, SHOWN_OTHERS), left = group.filter(row => row !== self && !shown.includes(row))
  // The headline's "N others from $X": the services on the table besides Nightmail (the vendor and the six), and the lowest
  // of their prices at the middle size, the one the caption names. Scoped by the count, never "alternatives start at".
  const counted = [self, ...shown], lowest = Math.min(...counted.map(mid))
  if (!Number.isFinite(lowest) || counted.some(row => row.bills[1]!.theirsCents === null) || !(ours[1]!.oursUc < BigInt(lowest) * 1_000_000n))
    throw new Error(`/alternatives/${c.slug}'s headline would price ${counted.length} services from ${money(lowest)} at ${formatCount(sizes[1]!)}: each must have a price there above Nightmail's (docs/alternatives.ts).`)
  const checked = [...new Set([self, ...shown].map(row => row.o.offer.checked))].sort()
  const when = checkedOn(checked)

  // ---------------------------------------------------------------- the page: the headline, one table, the facts

  const middleBill = ours[1]!, size = perSize(c, sizes[1]!)
  const h1: Doc['h1'] = [[`${productName} `, { ours: middleBill.ours, sent: middleBill.u.sent, received: middleBill.u.received }, '.'], [`${counted.length} others from ${money(lowest)}.`]]
  const caption = `${vendor} and ${spelled(shown.length)} alternatives, ${size.charAt(0).toLowerCase()}${size.slice(1)} · checked ${when.replaceAll(' ', '\u00a0')}`
  const assume = m.per === 'contact' ? `${m.sendsPerContact} emails a month to each contact, ${m.seats === 1 ? '1 teammate' : `${m.seats} teammates`}` : 'One recipient each, nothing received'
  const head = [m.per === 'contact' ? 'Contacts' : 'Emails a month', ...sizes.map(formatCount)]
  const row = ({ o, bills }: (typeof group)[number]) => ({ mark: o === c, cells: [[{ text: o.offer.vendor, href: o.path }], ...bills.map(b => [b.theirs ?? '—'])] as Text[] })
  const nightmailRow = { cells: [[productName], ...ours.map(b => [{ ours: b.ours, sent: b.u.sent, received: b.u.received }])] as Text[] }
  const table = (rows: (typeof group)[number][], note: Text): Table => ({ kind: 'table', numeric: [1, 2, 3], caption: note, head, rows: [nightmailRow, ...rows.map(row)] })
  const claim = `${productName} costs less than each service here at every size shown.`
  // Priced by contacts, the columns are contacts, and Nightmail's bill follows the emails they're sent: said per column.
  const perColumn = m.per === 'contact' ? ` ${productName}’s figures are for ${ours.slice(0, -1).map(b => formatCount(b.u.sent)).join(', ')} and ${formatCount(ours.at(-1)!.u.sent)} emails a month (${m.sendsPerContact} to each contact); the others are priced by contacts, with ${m.seats === 1 ? '1 teammate' : `${m.seats} teammates`}.` : ''
  const dash = (rows: (typeof group)[number][]) => rows.some(r => r.bills.some(b => b.theirsCents === null)) ? DASH : ''
  const visible: Section = {
    id: 'alternatives', title: `${vendor} alternatives, a month at three sizes`, quiet: true,
    blocks: [folded(table([self, ...shown], [`${claim} ${productName}: ${nightmail.perThousand} per 1,000 emails, sent or received, after ${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free a month.${perColumn} The others: monthly list prices before tax, each one’s least expensive plan for the size, checked ${when}; each name links to its comparison and the page it was read on.${dash([self, ...shown])}`]))],
  }
  const sections: Section[] = [visible, briefFactsSection(rowLines(c.rows))]

  // ---------------------------------------------------------------- the Markdown copy: every service, the basis, the pages read

  // The pages each priced cell was read on, a script or data file as the pricing page it belongs to (prices.ts).
  const read = (rows: (typeof group)[number][]) => rows.flatMap(({ o, bills }) => shownSources(bills.flatMap(b => { const q = quote(o.offer, b.u); return q.kind === 'price' ? [q.tier.source, ...q.payg?.tier.overageSource ? [q.payg.tier.overageSource] : []] : [] }), o.offer))
  const lacks = comparisonQuestions(c).find(item => item.id === 'lacks')
  const cited = read([self, ...shown]), all: Source[] = [...new Map([...read(group), ...(c.gaps ?? []).map(item => item.source)].map(source => [source.url, source])).values()]
  const copySections: Section[] = [
    { id: 'every', title: `${groupOf(c).title}: every one compared, at the same sizes`, blocks: [table([self, ...group.filter(row => row !== self)], [
      `${assume}, each service’s least expensive plan that holds it. Monthly list prices before tax, no promotions, read ${when} on each service’s pricing page (its comparison names the page and quotes it). ${productName}: ${nightmail.perThousand} per 1,000 emails, sent or received, after ${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free a month. ${claim}${dash(group)}`,
    ])] },
    ...left.length ? [{ id: 'left', title: 'Not on the page’s table', blocks: [{ kind: 'p' as const, text: [`The page lists the ${shown.length} lowest of those with a price read at ${formatCount(sizes[1]!)}${m.per === 'contact' ? ' contacts' : ' emails a month'}, besides ${vendor}, so it stays one table on a phone. The others here: ${left.map(r => r.o.offer.vendor).join(', ')}. Every comparison is on `, { text: 'the comparisons page', href: '/compare' }, '.'] }] }] : [],
    // What the vendor has that Nightmail doesn't: its sourced gaps, or else the comparison's older list.
    ...c.gaps?.length ? [gapsSection(c)] : lacks ? [{ id: 'lacks', title: lacks.question, blocks: [{ kind: 'p' as const, text: [lacks.answer] }] }] : [],
  ]

  // ---------------------------------------------------------------- its title, description, links and card

  const path = `/alternatives/${c.slug}`
  const searchTitle = fitWords([`${vendor} alternatives (${month(checked.at(-1)!)}): prices at three sizes`, `${vendor} alternatives (${month(checked.at(-1)!)}): prices compared`, `${vendor} alternatives (${month(checked.at(-1)!)})`], 60)
  const lead = `${vendor} alternatives, checked ${when}: ${size.charAt(0).toLowerCase()}${size.slice(1)}, Nightmail ${middleBill.ours}, ${vendor} ${self.bills[1]!.theirs}`
  const description = fitWords([
    `${lead}, and ${shown.length} more from ${money(Math.min(...shown.map(mid)))}. Each at three sizes.`,
    `${lead}, and ${shown.length} more from ${money(Math.min(...shown.map(mid)))}, each at three sizes, side by side.`,
    `${lead}, and ${shown.length} more from ${money(Math.min(...shown.map(mid)))}. Each at three sizes, side by side.`,
    `${lead}, and ${shown.length} more from ${money(Math.min(...shown.map(mid)))}.`,
    `${lead}, ${shown.length} more from ${money(Math.min(...shown.map(mid)))}.`,
    `${lead}. ${shown.length + 1} services at three sizes, side by side.`,
    `${lead}.`,
  ], 160, 140)
  const related = [
    { title: `${vendor} pricing`, path: `/pricing/${c.slug}`, line: `Every ${vendor} plan, and what a month costs at each size.` },
    { title: c.title, path: c.path, line: `${vendor} and ${productName} at every size ${vendor} prices, side by side.` },
    { title: 'Compare', path: '/compare', line: `${productName} beside every email service it is compared with.` },
  ]
  const cardWords: Doc['cardWords'] = { lines: [`${productName} ${middleBill.ours}.`, `${counted.length} others from ${money(lowest)}.`], caption: fitWords([`${vendor} and ${spelled(shown.length)} alternatives, ${size.replace(/^Per /, '')}, checked ${when}.`, `${vendor} and ${spelled(shown.length)} alternatives, checked ${when}.`, `${vendor} and ${shown.length} more, checked ${when}.`], 70) }
  return {
    path, title: `${vendor} alternatives`, searchTitle, description, h1, answer: [[caption]], cardWords, sections, questions: [],
    sources: [], cited, copy: { sections: copySections, questions: [], sources: all, related: [] },
    related, focus: c.focus, modified: checked.at(-1)!,
    crumbs: [{ name: productName, path: '/' }, { name: 'Compare', path: '/compare' }, { name: `${vendor} alternatives`, path }],
    about: { name: vendor, url: c.offer.pricing },
    items: [{ name: productName, url: `${publicOrigin}/pricing` }, ...[self, ...shown].map(r => ({ name: r.o.offer.vendor, url: `${publicOrigin}${r.o.path}` }))],
    llms: `${plain(h1[0])} ${plain(h1[1])} ${caption.replaceAll('\u00a0', ' ')}: ${[self, ...shown].map(r => `${r.o.offer.vendor} ${r.bills[1]!.theirs}`).join(', ')}.`,
  }
}
