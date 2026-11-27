// (With extensions: the build's config imports this file, app/price-pages.ts.)
import { productName } from '../../../../../api/src/brand.ts'
import { COMPARISONS } from '../compare/index.ts'
import { comparisonQuestions } from '../questions.ts'
import { dayOf, formatCount, lastChecked, money, nightmail, nightmailBill, shownSources, sourcesOf, theirPrice, type Comparison, type Usage } from '../prices.ts'
import { briefFactsSection, rowLines } from './facts.ts'
import { folded, type PageDoc, type Table, type Text } from './shape.ts'
import { ownPages } from '../docs/registry.ts'

// A comparison (/compare/<slug>) as a page (shape.ts): the verdict first, both prices at the comparison's middle size and
// the day they were read; then the price table, every size the vendor's own page prices; the questions (questions.ts);
// what the figures assume and Nightmail's terms, and the pages read, folded under the table; the vendor's other pages. Every figure is the
// price pages' arithmetic (prices.ts), Nightmail's from the billing code.

/** The comparison's three groups, as /compare lists them and each page's More links and breadcrumb name them. */
export const GROUPS = [
  { focus: 'developer', id: 'developer', title: 'Developer email APIs', noun: 'developer email APIs' },
  { focus: 'newsletter', id: 'newsletter', title: 'Newsletter and marketing', noun: 'newsletter and marketing services' },
  { focus: 'agents', id: 'agents', title: 'Agent inboxes', noun: 'services for agent inboxes' },
] as const
export const groupOf = (c: Comparison) => GROUPS.find(group => group.focus === c.focus)!
/** The comparisons in the groups' order (each group as compare/index.ts lists it). */
export const ORDERED = GROUPS.flatMap(group => COMPARISONS.filter(c => c.focus === group.focus))

/** A size in the comparison's own unit: its middle one, as the page opens on it. */
export const middle = (c: Comparison) => sizeOf(c, c.sizes[1]!)
const sizeOf = (c: Comparison, u: Usage) => c.offer.unit === 'contacts' ? u.contacts : c.offer.unit === 'inboxes' ? u.inboxes ?? 0 : c.model.per === 'received' ? u.received : u.sent
/** Both bills at a size; theirs null where the vendor's page prices no plan there. */
export function billAt(c: Comparison, size: number) {
  const u = c.use(size), ours = nightmailBill(u.sent, u.received), theirs = theirPrice(c.offer, u)
  return { size, u, ours: ours.text, oursUc: ours.uc, theirs: theirs ? money(theirs.cents) : null, theirsCents: theirs?.cents ?? null, plan: theirs?.plan ?? null }
}
/** What a size is, with the emails it means where the unit isn't emails: "Per 100,000 emails a month", "Per 25,000
 *  contacts, 100,000 emails a month", "Per 100 agent inboxes, 10,000 received and 5,000 sent a month". */
export function perSize(c: Comparison, size: number) {
  const u = c.use(size), n = formatCount(size)
  return c.model.per === 'contact' ? `Per ${n} contacts, ${formatCount(u.sent)} emails a month`
    : c.model.per === 'inbox' ? `Per ${n} agent inboxes, ${formatCount(u.received)} received and ${formatCount(u.sent)} sent a month`
      : c.model.per === 'received' ? `Per ${n} emails received a month` : `Per ${n} emails a month`
}
/** The verdict: Nightmail's bill and the vendor's at a size (the middle one, unless a page says otherwise: a vendor's
 *  pricing page opens on its smallest paid plan, docs/vendor-pricing.ts), and that size with the day read. */
export function verdictOf(c: Comparison, size = middle(c)) {
  const b = billAt(c, size)
  // (The day's words don't break apart: "25 Nov 2026" stays on one line. Where the caption wraps, page.tsx breaks it at
  // the dot, and drops the dot.)
  return { ours: b.ours, theirs: b.theirs!, u: b.u, at: `${perSize(c, b.size)} · checked ${dayOf(c.offer.checked).replaceAll(' ', '\u00a0')}` }
}
const unitHead = (c: Comparison) => c.model.per === 'contact' ? 'Contacts' : c.model.per === 'inbox' ? 'Inboxes' : c.model.per === 'received' ? 'Received a month' : 'Emails a month'

/** The verdict's two lines: Nightmail's bill, its figure marked, then the vendor's. */
export const verdictHeading = (c: Comparison, v: ReturnType<typeof verdictOf>): Text[] =>
  [[`${productName} `, { ours: v.ours, sent: v.u.sent, received: v.u.received }, '.'], [`${c.offer.vendor} ${v.theirs}.`]]
/** The price table: every size the vendor's own page prices, both bills and the vendor's plan, one size marked. A
 *  comparison's and the vendor's pricing page (docs/vendor-pricing.ts) draw the same one, so the two can't drift. */
export function priceTable(c: Comparison, caption: Text, mark: number): Table {
  const vendor = c.offer.vendor
  return {
    kind: 'table', caption, head: [unitHead(c), productName, vendor, `${vendor} plan`], numeric: [1, 2],
    rows: c.steps.map(size => { const b = billAt(c, size); return { mark: size === mark, cells: [[formatCount(size)], [b.ours], [b.theirs ?? '—'], [b.plan ?? '']] } }),
  }
}

export function comparisonDoc(c: Comparison): PageDoc {
  const vendor = c.offer.vendor, v = verdictOf(c), opening = middle(c), m = c.model
  // (Only what the pre-merge check asks a comparison to tell a buyer; the rate and the free allowance are the facts'.)
  const terms: Text = [`${c.assume} Monthly billing, no promotions. ${productName} is prepaid. Top-ups start at ${nightmail.minTopUp} and expire ${nightmail.expiresAfterMonths} months after purchase; received mail kept past ${nightmail.storageAfterDays} days is ${nightmail.storagePerGb} per GB a month after ${nightmail.freeStorageGb} GB free.`]
  return {
    path: c.path, title: c.title, searchTitle: c.searchTitle, description: c.description,
    h1: verdictHeading(c, v),
    answer: [[v.at]],
    // (The line under the heading is answer, the verdict's size and the day: by contacts or inboxes, the count and the mail
    // it means, perSize, since the headline's figures hold only at that mail.)
    // The table, and under it only How we compared, closed, with the whole note and the pages read (page.tsx).
    sections: [{ id: 'sizes', title: `A month at each size ${vendor} prices`, quiet: true, blocks: [folded(priceTable(c, terms, opening))] },
    // What Nightmail has that the vendor charges for or lacks, in four short lines (facts.ts, briefFacts).
    briefFactsSection(rowLines(c.rows))],
    questions: comparisonQuestions(c),
    sources: shownSources(sourcesOf(c), c.offer),
    // The vendor's own pages (docs/registry.ts: its pricing and alternatives pages), then every comparison on /compare,
    // which lists them all (Ryan: one quiet row of at most six links).
    related: [...ownPages(c.slug).map(path => path.startsWith('/alternatives/')
      ? { title: `${vendor} alternatives`, path, line: `${productName} and the services nearest ${vendor} in price, at three sizes.` }
      : { title: `${vendor} pricing`, path, line: `Every ${vendor} plan, and what a month costs at each size.` }),
      { title: 'All comparisons', path: '/compare', line: `${productName} beside every email service it is compared with.` }],
    crumbs: [{ name: productName, path: '/' }, { name: 'Compare', path: '/compare' }, { name: vendor, path: c.path }],
    about: { name: vendor, url: c.offer.pricing }, modified: lastChecked(c), focus: c.focus,
    llms: `${productName} ${v.ours}, ${vendor} ${v.theirs}: ${v.at.replaceAll('\u00a0', ' ').toLowerCase()}.`,
  }
}
