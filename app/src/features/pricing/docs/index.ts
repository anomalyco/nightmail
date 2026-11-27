// (With extensions: the build's config imports this file, through pages.ts.)
import { comparisons } from '../compare/index.ts'
import type { Doc } from './doc.ts'
import { emailForAgents } from './agents.ts'
import { cheapestEmailApi } from './cheapest.ts'
import { freeEmailApi } from './free.ts'
import { vendorAlternatives } from './alternatives.ts'
import { ALTERNATIVES_VENDORS, PRICING_VENDORS } from './registry.ts'
import { vendorPricing } from './vendor-pricing.ts'
import { hubCard, hubDoc } from '../page/hub.ts'
import { BRIEF, factsFor, rowLines, SHARED_FACTS, wordCount } from '../page/facts.ts'
import { plain } from '../page/shape.ts'
import { comparisonDoc } from '../page/comparison.ts'
import { PANELS } from '../panels.ts'

// The pages that answer a question about email prices (docs/doc.ts), every one the registry names (registry.ts). pages.ts
// lists them among the price pages, so each gets what a price page gets (app/price-pages.ts): its own HTML with the words
// in it, its Markdown twin, its structured data, its sitemap entry and its line in llms.txt.

const pricingVendors = PRICING_VENDORS.map(slug => ({ slug, vendor: comparisons[slug]!.vendor }))
export const DOCS: Doc[] = [
  ...PRICING_VENDORS.map(slug => vendorPricing(comparisons[slug]!, pricingVendors)),
  ...ALTERNATIVES_VENDORS.map(slug => vendorAlternatives(comparisons[slug]!)),
  // The use-case pages, each from the comparisons of its kind.
  emailForAgents(),
  cheapestEmailApi(),
  freeEmailApi(),
]

/** A vendor's pricing page needs this much of its own to be worth an address: a page with less is a template with a name
 *  in it, and the build refuses it (docProblems). */
/** The one search phrase a title may ask as a question, on the one page that answers it: /cheapest-email-api's "Cheapest
 *  email API? 15 priced …" (docs/cheapest.ts), which states nothing about Nightmail. Exactly that, case-sensitive, and only
 *  there; nothing about "best" is exempt. */
const QUESTION = { path: '/cheapest-email-api', title: /^Cheapest email API\? / }

export const ENOUGH = { pricePoints: 4, citedFacts: 1, sizes: 3 }

/** What's wrong with the pages, as the build reports it (app/price-pages.ts): a registry entry with no comparison, a
 *  vendor with too little data for a page of its own, a title or description outside its length, an answer without the
 *  day its figures were read, or a figure without its source. Empty when they can ship. */
export function docProblems(): string[] {
  const problems: string[] = []
  for (const slug of PRICING_VENDORS) {
    const c = comparisons[slug]
    if (!c) { problems.push(`docs/registry.ts names ${slug}, which has no comparison (compare/index.ts).`); continue }
    const points = c.offer.plans.flatMap(plan => plan.tiers).length, cited = c.rows.filter(row => row.source).length
    if (points < ENOUGH.pricePoints || cited < ENOUGH.citedFacts || c.steps.length < ENOUGH.sizes)
      problems.push(`/pricing/${slug} would be thin: ${points} price points, ${cited} sourced facts and ${c.steps.length} sizes, against at least ${ENOUGH.pricePoints}, ${ENOUGH.citedFacts} and ${ENOUGH.sizes}. Leave it out of docs/registry.ts.`)
  }
  for (const doc of DOCS) {
    if (doc.searchTitle.length > 60) problems.push(`${doc.path}'s title is over 60 characters: ${doc.searchTitle}`)
    if (doc.description.length < 140 || doc.description.length > 160) problems.push(`${doc.path}'s description isn't 140 to 160 characters (${doc.description.length}): ${doc.description}`)
    if (!doc.cited.length) problems.push(`${doc.path}'s table cites no source.`)
    if (/\b(?:cheapest|best) (?:email|transactional|api|provider|service|option|choice|alternative|way to send|free)|\b(?:largest|biggest|most generous|highest) free\b|\bmost generous\b|Nightmail[^.]*\b(?:cheapest|best)\b/i.test([doc.path === QUESTION.path ? doc.searchTitle.replace(QUESTION.title, '') : doc.searchTitle, doc.description, JSON.stringify([doc.h1, doc.answer, doc.cardWords, doc.sections, doc.copy, doc.llms])].join(' ')))
      problems.push(`${doc.path} says "cheapest" or "best": no page states either of Nightmail (Ryan, A294).`)
    if (/\bAmazon SES\b|\bBento\b/.test(JSON.stringify(doc))) problems.push(`${doc.path} names Amazon SES or Bento: pages compare only providers Nightmail costs less than (Ryan, A294).`)
  }
  // A card gives the day or days read exactly as its page's caption does (docs/alternatives.ts, checkedOn), never only the
  // latest of a span.
  const pageText = (answer: unknown) => JSON.stringify(answer).replaceAll('\\u00a0', ' ').replaceAll('\u00a0', ' ')
  for (const { path, card, answer } of [...DOCS.map(doc => ({ path: doc.path, card: doc.cardWords.caption, answer: doc.answer })), { path: '/compare', card: hubCard().caption, answer: hubDoc().answer }]) {
    const day = card.match(/checked ([^.]+)\./)?.[1]
    if (day && !pageText(answer).includes(`checked ${day}`)) problems.push(`${path}'s card says "checked ${day}", which its page's caption doesn't.`)
  }
  // What a vendor has that Nightmail doesn't can't be something Nightmail's own lists say it has: the facts every page
  // says, the product's panels, and the comparison's own lines (its "With Nightmail" list).
  for (const c of Object.values(comparisons)) for (const item of c.gaps ?? []) {
    const ours = [...Object.values(SHARED_FACTS).map(fact => fact.text), ...Object.values(PANELS).flatMap(panel => [panel.title, panel.line]), ...factsFor(rowLines(c.rows)),
      ...c.rows.map(row => row.source ? row.text.replace(row.note ?? '', '') : row.text)]
    const says = ours.find(line => item.subject.test(line))
    if (says) problems.push(`/compare/${c.slug} lists "${item.what}" as something ${c.offer.vendor} has that Nightmail doesn't, and Nightmail's own facts say "${says}".`)
  }
  // What a page shows besides its table's cells, its headline, its button and its row of links, every disclosure closed
  // (Ryan: "way too much text … nobody's reading that"; then "i don't think we need the thing that says list prices
  // before tax"): the line under the heading, with the day and the size the headline prices (by contacts or inboxes, the
  // mail too, since the figures hold only at that mail), at most 15 words; nothing under a table but How we compared,
  // which holds its whole note; the facts at most four of at most six words; in all at most what the pages carry now (39
  // words on a ranking page, 40 on a vendor's pricing or alternatives page, 42 on a comparison), so nothing creeps back.
  // (The sign-in terms under the button are the shared component's, and a comparison's closed questions are its
  // questions, not fine print: neither is counted.)
  for (const doc of [...DOCS, ...Object.values(comparisons).map(comparisonDoc)]) {
    const caption = plain(doc.caption ?? doc.answer[0] ?? []), comparison = doc.path.startsWith('/compare/'), vendor = /^\/(?:pricing|alternatives)\//.test(doc.path)
    if (wordCount(caption) > 15 || !/checked \d/.test(caption.replaceAll('\u00a0', ' '))) problems.push(`${doc.path}'s line under the heading should be at most 15 words with the day read: "${caption}"`)
    let words = wordCount(caption)
    for (const section of doc.sections) {
      if (!section.quiet && !(doc.sections.length === 1 && section.blocks[0]?.kind === 'table')) words += wordCount(section.title)
      for (const block of section.blocks) {
        if (block.kind === 'table') {
          if (!block.method) problems.push(`${doc.path}'s table shows its whole note: fold it into How we compared (docs/doc.ts, folded).`)
          else if (plain(block.caption).trim()) problems.push(`${doc.path} shows a line under its table ("${plain(block.caption)}"): it belongs in How we compared, with the rest of the note.`)
          words += wordCount(plain(block.caption)) + (block.method ? wordCount('How we compared') : 0)
        } else if (block.kind === 'list') {
          if (section.id === 'facts' && (block.items.length > BRIEF.facts || block.items.some(item => wordCount(plain(item)) > BRIEF.words))) problems.push(`${doc.path} lists more than ${BRIEF.facts} facts or one over ${BRIEF.words} words.`)
          words += block.items.reduce((n, item) => n + wordCount(plain(item)), 0)
        } else words += wordCount(plain(block.text))
      }
    }
    const most = comparison ? 42 : vendor ? 40 : 39
    if (words > most) problems.push(`${doc.path} shows ${words} words besides its table, headline, button and links: at most ${most}.`)
  }
  if (new Set(DOCS.map(doc => doc.path)).size !== DOCS.length) problems.push('Two pages have the same address (docs/registry.ts).')
  return problems
}
