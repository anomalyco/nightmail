// (With extensions: the build's config imports this file, through pages.ts.)
import { productName, publicOrigin } from '../../../../../api/src/brand.ts'
import { fitWords, formatCount, money, nightmail, quote, shownSources, type Source } from '../prices.ts'
import { billAt, ORDERED } from '../page/comparison.ts'
import { briefFactsSection } from '../page/facts.ts'
import { folded, plain, type Doc, type Section, type Table, type Text } from './doc.ts'
import { checkedOn, DASH, month, spelled } from './alternatives.ts'

// /cheapest-email-api: the search "cheapest email API", answered with what the data shows and no more. The comparisons
// hold only services Nightmail costs less than (Ryan, A294) and name neither Amazon SES nor Bento, so the page never says
// Nightmail is the cheapest: its title asks the question with the count and the month, its headline is the scoped pair
// ("Nightmail $19. / 9 others from $30."), and one sentence under the table, at the top of the Markdown copy and in the
// description says what the list is: the services Nightmail has compared itself with, not every email service. The build
// stops if that sentence or the count is missing from any of them, and on any tie or loss in any priced cell.

/** The sizes, as /compare's sending table prices the developer APIs (page/hub.ts). */
export const CHEAPEST_SIZES = [10_000, 100_000, 1_000_000]
/** Services on the page's table: the lowest priced at the middle size, as many as stay one calm table on a phone (ten rows
 *  with Nightmail's, as /email-for-ai-agents), and any priced the same as the last of them: a tie at the cut is shown
 *  whole, never split by the order the data lists them in. The rest are in the Markdown copy. */
export const SHOWN_CHEAPEST = 9

export function cheapestEmailApi(): Doc {
  const services = ORDERED.filter(c => c.focus === 'developer' && c.model.per === 'email')
  const group = services.map(c => ({ c, bills: CHEAPEST_SIZES.map(size => billAt(c, size)) }))
  const mid = (row: (typeof group)[number]) => row.bills[1]!.theirsCents ?? Infinity
  group.sort((a, b) => mid(a) - mid(b))
  const ours = CHEAPEST_SIZES.map(size => billAt(services[0]!, size))
  // Ryan's rule (A294): Nightmail costs less than each service listed at every size shown; the build stops where it isn't.
  for (const { c, bills } of group) for (const b of bills) if (b.theirsCents !== null && !(b.oursUc < BigInt(b.theirsCents) * 1_000_000n))
    throw new Error(`/cheapest-email-api would show Nightmail at ${b.ours} and ${c.offer.vendor} at ${b.theirs} for ${formatCount(b.size)} emails a month: Nightmail must cost less at every size shown (docs/cheapest.ts).`)
  const priced = group.filter(row => row.bills[1]!.theirsCents !== null), cut = priced[SHOWN_CHEAPEST - 1]
  const shown = cut ? priced.filter((row, i) => i < SHOWN_CHEAPEST || mid(row) === mid(cut)) : priced, left = group.filter(row => !shown.includes(row))
  const lowest = Math.min(...shown.map(mid)), lowestAll = Math.min(...group.map(mid))
  if (lowest !== lowestAll || !(ours[1]!.oursUc < BigInt(lowest) * 1_000_000n)) throw new Error('/cheapest-email-api: the headline\'s "from" price must be the lowest of the services compared and above Nightmail\'s.')
  const checked = [...new Set(group.map(row => row.c.offer.checked))].sort()
  const when = checkedOn(checked)
  const n = group.length, at = formatCount(CHEAPEST_SIZES[1]!)

  // The sentence that says what the list is and isn't (Ryan: no page lets a reader conclude more than its table shows).
  const scope = `These are the ${n} email-sending APIs ${productName} has compared itself with, not every email service.`
  const middle = ours[1]!
  const h1: Doc['h1'] = [[`${productName} `, { ours: middle.ours, sent: middle.u.sent, received: middle.u.received }, '.'], [`${shown.length} others from ${money(lowest)}.`]]
  const caption = `${capital(spelled(shown.length))} of ${n} email APIs compared, per ${at} emails a month · checked ${when.replaceAll(' ', '\u00a0')}`
  const head = ['Emails a month', ...CHEAPEST_SIZES.map(formatCount)]
  const nightmailRow = { cells: [[productName], ...ours.map(b => [{ ours: b.ours, sent: b.u.sent, received: b.u.received }])] as Text[] }
  const row = ({ c, bills }: (typeof group)[number]) => ({ cells: [[{ text: c.offer.vendor, href: c.path }], ...bills.map(b => [b.theirs ?? '—'])] as Text[] })
  const dash = (rows: (typeof group)[number][]) => rows.some(r => r.bills.some(b => b.theirsCents === null)) ? DASH : ''
  const claim = `${productName} costs less than each service here at every size shown.`
  const terms = `${productName}: ${nightmail.perThousand} per 1,000 emails, sent or received, after ${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free a month.`
  const basis = 'One recipient each, nothing received. The others: monthly list prices before tax, each one’s least expensive plan for the size'
  const table = (rows: (typeof group)[number][], note: Text): Table => ({ kind: 'table', numeric: [1, 2, 3], caption: note, head, rows: [nightmailRow, ...rows.map(row)] })
  const rule = `the ${spelled(Math.min(SHOWN_CHEAPEST, priced.length))} lowest, and any priced the same as the last of them`
  const visibleNote: Text = [`${scope} The table shows the ${shown.length} lowest of those with a price read at ${at} emails a month (${rule}); `, { text: 'the comparisons page', href: '/compare' }, ` has every one. ${claim} ${terms} ${basis}, checked ${when}; each name links to its comparison and the page it was read on.${dash(shown)}`]
  const sections: Section[] = [
    { id: 'apis', title: `Email APIs: a month at ${CHEAPEST_SIZES.map(formatCount).join(', ')} emails`, quiet: true, blocks: [folded(table(shown, visibleNote))] },
    briefFactsSection(),
  ]
  const read = (rows: (typeof group)[number][]) => rows.flatMap(({ c, bills }) => shownSources(bills.flatMap(b => { const q = quote(c.offer, b.u); return q.kind === 'price' ? [q.tier.source, ...q.payg?.tier.overageSource ? [q.payg.tier.overageSource] : []] : [] }), c.offer))
  const cited = read(shown), all: Source[] = [...new Map(read(group).map(source => [source.url, source])).values()]
  const copySections: Section[] = [
    { id: 'every', title: `All ${n} email APIs compared, at the same sizes`, blocks: [table(group, [`${scope} ${claim} ${terms} ${basis}, no promotions, read ${when} on each service’s pricing page (its comparison names the page and quotes it).${dash(group)}`])] },
    ...left.length ? [{ id: 'left', title: 'Not on the page’s table', blocks: [{ kind: 'p' as const, text: [`The page lists the ${shown.length} lowest of those with a price read at ${at} emails a month (${rule}), so it stays one table on a phone. The others here: ${left.map(r => r.c.offer.vendor).join(', ')}.`] }] }] : [],
  ]

  const path = '/cheapest-email-api', latest = checked.at(-1)!
  const searchTitle = fitWords([`Cheapest email API? ${productName} and ${n} others priced (${month(latest)})`, `Cheapest email API? ${n} priced at three sizes (${month(latest)})`, `Cheapest email API? ${n} compared (${month(latest)})`], 60)
  // Every form says "a month" and the day or days read; only the words around them shorten.
  const description = fitWords([
    `Email API prices, checked ${when}: ${productName} and the ${n} email-sending APIs it has compared itself with. At ${at} emails a month, ${productName} ${middle.ours}, the others from ${money(lowestAll)}.`,
    `Email API prices, checked ${when}: ${productName} and the ${n} email-sending APIs it compared itself with. At ${at} emails a month, ${productName} ${middle.ours}, others from ${money(lowestAll)}.`,
    `Email API prices, checked ${when}: ${productName} and ${n} email-sending APIs it compared itself with. ${at} emails a month: ${productName} ${middle.ours}, others from ${money(lowestAll)}.`,
  ], 160, 140)
  const doc: Doc = {
    path, title: 'Email API prices', searchTitle, description, h1, answer: [[caption]], caption: [`${capital(spelled(shown.length))} of ${n} email APIs, per ${at} emails a month · checked ${when.replaceAll(' ', '\u00a0')}`], sections, questions: [],
    cardWords: { lines: [`${productName} ${middle.ours}.`, `${shown.length} others from ${money(lowest)}.`], caption: fitWords([`${capital(spelled(shown.length))} of ${n} email APIs compared, ${at} emails a month.`, `${capital(spelled(shown.length))} of ${n} email APIs compared, checked ${when}.`], 70) },
    sources: [], cited, copy: { sections: copySections, questions: [], sources: all, related: [] }, lead: scope,
    related: [
      { title: 'Compare', path: '/compare', line: `${productName} beside every email service it is compared with.` },
      { title: 'Price calculator', path: '/pricing', line: `What ${productName} costs at your own numbers.` },
    ],
    focus: 'developer', modified: latest,
    crumbs: [{ name: productName, path: '/' }, { name: 'Compare', path: '/compare' }, { name: 'Email API prices', path }],
    about: { name: productName, url: `${publicOrigin}/` },
    items: [{ name: productName, url: `${publicOrigin}/pricing` }, ...shown.map(r => ({ name: r.c.offer.vendor, url: `${publicOrigin}${r.c.path}` }))],
    llms: `${plain(h1[0])} ${plain(h1[1])} ${caption.replaceAll('\u00a0', ' ')}. ${scope}`,
  }
  // The count and the scope in each place a reader or a crawler meets the page; the build stops where either is missing.
  const page = JSON.stringify([doc.h1, doc.answer, doc.sections]), copy = JSON.stringify(doc.copy)
  const missing = [
    !page.includes(scope) && 'the page', !copy.includes(scope) && 'the Markdown copy', !doc.llms.includes(scope) && 'its llms.txt line',
    !doc.description.includes(`${n} email-sending APIs`) && 'the description (the count)', !/compared itself with/.test(doc.description) && 'the description (the scope)',
  ].filter(Boolean)
  if (missing.length) throw new Error(`/cheapest-email-api leaves out what its list is in ${missing.join(', ')} (docs/cheapest.ts).`)
  return doc
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
