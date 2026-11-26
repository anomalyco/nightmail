// (With extensions: the build's config imports this file, price-pages.ts.)
import { COMPARISONS, OFFERS } from './compare/index.ts'
import type { Doc } from './docs/doc.ts'
import { DOCS } from './docs/index.ts'
import { claim, formatCount, lastChecked, listOf, money, nightmail, nightmailBill, quote, theirPrice, type Comparison } from './prices.ts'

/** A page's link-preview card: a picture of the page as it opens (scripts/price-cards.mjs makes it), named by a hash of
 *  every figure and claim on it, so when a price changes the build asks for a new card (price-pages.ts) rather than
 *  sharing an old one. */
const hash = (text: string) => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193); return (h >>> 0).toString(36) }
const card = (slug: string, alt: string, shown: string[]) => ({ file: `og/${slug}-${hash([alt, ...shown].join('|'))}.jpg`, alt })
// What each page opens on: the calculator at its middle size (content.tsx), a comparison at its middle size (board.tsx).
const opening = COMPARISONS.find(c => c.slug === 'mailchimp')!.sizes[1]!, bill = nightmailBill(opening.sent, opening.received).text
function boardCard(c: Comparison) {
  const u = c.sizes[1]!, ours = nightmailBill(u.sent, u.received).text, theirs = money(theirPrice(c.offer, u)!.cents)
  const at = c.offer.unit === 'contacts' ? `${formatCount(u.contacts)} contacts` : c.offer.unit === 'inboxes' ? `${formatCount(u.inboxes ?? 0)} inboxes` : `${formatCount(u.sent)} emails`
  return card(`compare-${c.slug}`, `The Nightmail vs ${c.offer.vendor} board under the headline “${claim(c).replaceAll('\u00a0', ' ')}”: a month at ${at}, Nightmail ${ours} and ${c.offer.vendor} ${theirs}.`, [ours, theirs])
}

/** A pricing page's link-preview card (null: index.html's own, the homepage's). The cards' one style will make each from the
 *  page's two lines and caption (doc.verdict); until it does, every pricing page has the homepage's. */
const docCard = (_doc: Doc): PricePage['card'] => null

export type PricePage = { path: string; file: string; title: string; searchTitle: string; description: string; card: { file: string; alt: string } | null; comparison: Comparison | null; doc: Doc | null; modified: string }
const vendors = listOf([...new Set(OFFERS.map(offer => offer.vendor))])
const free = `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free a month`
/** Each page's address, the HTML file the build writes for it (served at that address by Workers Assets and by
 *  api/src/server.ts), its name on the site (title), and its title, description and card (null: the homepage's) in the browser tab, search
 *  results and link previews (searchTitle, at most 60 characters, and description, at most 160: price-pages.ts checks
 *  both), and the last day any figure on it was read (modified: the sitemap's lastmod and the page's dateModified). The
 *  calculator, then a page for every comparison (compare/index.ts; prices.ts, searchWords), then the pricing pages
 *  (docs/index.ts: /pricing/<vendor>), each made from one data object (docs/doc.ts). */
export const PRICE_PAGES: PricePage[] = [
  { path: '/pricing', file: 'pricing.html', title: 'Price calculator', comparison: null, doc: null, modified: OFFERS.map(offer => offer.checked).sort().at(-1)!,
    searchTitle: `Nightmail pricing: ${nightmail.perThousand} per 1,000 emails, sent or received`,
    description: [`${nightmail.perThousand} per 1,000 emails, sent or received, after ${free}. Contacts and teammates are free. Compare ${vendors}.`,
      `${nightmail.perThousand} per 1,000 emails, sent or received, after ${free}. Contacts and teammates are free.`].find(text => text.length <= 160)!,
    card: card('pricing', `The Nightmail price board under the headline “What Nightmail costs at your size”: a month at ${formatCount(opening.sent)} emails to ${formatCount(opening.contacts)} contacts, Nightmail ${bill}, ${listOf(OFFERS.flatMap(offer => { const q = quote(offer, opening); return q.kind === 'price' ? [`${offer.name} ${money(q.payg?.cents ?? q.cents)}`] : [] }))}.`, []) },
  ...COMPARISONS.map(c => ({ path: c.path, file: `compare/${c.slug}.html`, title: c.title, searchTitle: c.searchTitle, description: c.description, card: boardCard(c), comparison: c, doc: null, modified: lastChecked(c) })),
  ...DOCS.map(doc => ({ path: doc.path, file: `${doc.path.slice(1)}.html`, title: doc.title, searchTitle: doc.searchTitle, description: doc.description, card: docCard(doc), comparison: null, doc, modified: doc.modified })),
]
