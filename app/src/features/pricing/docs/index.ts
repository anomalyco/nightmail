// (With extensions: the build's config imports this file, through pages.ts.)
import { comparisons } from '../compare/index.ts'
import type { Doc } from './doc.ts'
import { PRICE_PAGES_VERDICT } from '../live.ts'
import { PRICING_VENDORS } from './registry.ts'
import { vendorPricing } from './vendor-pricing.ts'

// The pages that answer a question about email prices (docs/doc.ts), every one the registry names (registry.ts), in a
// build that has them (live.ts, PRICE_PAGES_VERDICT: none in production's yet). pages.ts lists them among the price pages, so each gets what a price page gets (app/price-pages.ts): its own HTML with the words
// in it, its Markdown twin, its structured data, its sitemap entry and its line in llms.txt.

const pricingVendors = PRICING_VENDORS.map(slug => ({ slug, vendor: comparisons[slug]!.vendor }))
export const DOCS: Doc[] = PRICE_PAGES_VERDICT ? PRICING_VENDORS.map(slug => vendorPricing(comparisons[slug]!, pricingVendors)) : []

/** A vendor's pricing page needs this much of its own to be worth an address: a page with less is a template with a name
 *  in it, and the build refuses it (docProblems). */
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
    if (!doc.sources.length) problems.push(`${doc.path} cites no source.`)
    if (/\b(?:cheapest|best) (?:email|transactional|api|provider|service|option|choice|alternative|way to send)|Nightmail[^.]*\b(?:cheapest|best)\b/i.test([doc.searchTitle, doc.description, doc.h1, JSON.stringify(doc.answer), JSON.stringify(doc.sections), JSON.stringify(doc.questions)].join(' ')))
      problems.push(`${doc.path} says "cheapest" or "best": no page states either of Nightmail (Ryan, A294).`)
    if (/\bAmazon SES\b|\bBento\b/.test(JSON.stringify(doc))) problems.push(`${doc.path} names Amazon SES or Bento: pages compare only providers Nightmail costs less than (Ryan, A294).`)
  }
  if (new Set(DOCS.map(doc => doc.path)).size !== DOCS.length) problems.push('Two pages have the same address (docs/registry.ts).')
  return problems
}
