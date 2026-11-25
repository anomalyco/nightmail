// (With extensions: the build's config imports this file, price-pages.ts.)
import { productName, publicOrigin } from '../../../../api/src/brand.ts'
import { COMPARISONS, OFFERS } from './compare/index.ts'
import { PRICE_PAGES, type PricePage } from './pages.ts'
import { FIRST_STEP, PANEL_IDS, PANELS } from './panels.ts'
import { billMath, claim, dayOf, formatCount, lastChecked, listOf, money, nightmail, nightmailBill, sourcesOf, theirPrice, vendorRows, type Comparison, type Usage } from './prices.ts'

// What the public pages say, for readers that aren't browsers (app/price-pages.ts writes each file): a Markdown twin of
// the homepage (/index.md), the calculator (/pricing.md) and each comparison (/compare/<slug>.md) with the same facts
// as the page, their structured data (JSON-LD), llms.txt's lines for them and llms-full.txt. All of it is made from
// the same data as the pages (prices.ts, compare/, panels.ts), so it can't say something the page doesn't.

const url = (path: string) => publicOrigin + path
/** A page's Markdown twin: /pricing.md, /compare/<slug>.md, and the homepage's /index.md. */
export const markdownPath = (path: string) => path === '/' ? '/index.md' : `${path}.md`
const host = (page: string) => new URL(page).hostname.replace(/^www\./, '')
const cell = (text: string) => text.replaceAll('|', '\\|')
const table = (head: string[], rows: string[][], right: number[] = []) => [
  `| ${head.join(' | ')} |`, `| ${head.map((_, i) => right.includes(i) ? '---:' : '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`),
].join('\n')
const free = `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received`
/** What Nightmail charges, as every page's small print says it. */
const terms = () => [
  `- ${nightmail.perThousand} per 1,000 emails, sent or received, after ${free} free every month. Contacts and teammates: no charge.`,
  `- Paid from prepaid credit. Top-ups start at ${nightmail.minTopUp} and expire ${nightmail.expiresAfterMonths} months after purchase.`,
  `- Received mail kept past ${nightmail.storageAfterDays} days: ${nightmail.storagePerGb} per GB a month after ${nightmail.freeStorageGb} GB free.`,
].join('\n')
/** Every page a comparison's figures were read on, once each, with the day. */
const pagesRead = (c: Comparison) => [...new Map(sourcesOf(c).map(source => [source.url, source])).values()]
const trademarks = `Product names belong to their owners and only identify their products. ${productName} isn’t affiliated with them.`
const comparisonLinks = (except?: string) => COMPARISONS.filter(c => c.slug !== except).map(c => `- [${c.title}](${url(markdownPath(c.path))}): ${c.description}`).join('\n')

/** A comparison's page in Markdown: its headline, the board at every size its fader reaches, the rows with their
 *  sources, Also in the box, the terms and the page's small print. */
export function comparisonMarkdown(c: Comparison): string {
  const unit = c.offer.unit, vendor = c.offer.vendor
  // The size, then the emails it means: sent to the contacts, or received and sent by the inboxes.
  const sizeCells = (size: number, u: Usage) => unit === 'contacts' ? [formatCount(size), formatCount(u.sent)] : unit === 'inboxes' ? [formatCount(size), formatCount(u.received), formatCount(u.sent)] : [formatCount(size)]
  const sizeHead = unit === 'contacts' ? ['Contacts', 'Emails a month'] : unit === 'inboxes' ? ['Inboxes', 'Received a month', 'Sent a month'] : c.model.per === 'received' ? ['Received a month'] : ['Emails a month']
  const rows = c.steps.map(size => {
    const u = c.use(size), ours = nightmailBill(u.sent, u.received), theirs = theirPrice(c.offer, u)!
    return [...sizeCells(size, u), ours.text, money(theirs.cents), theirs.plan]
  })
  const head = [...sizeHead, productName, vendor, `${vendor} plan`]
  return [
    `# ${c.title}`,
    `> ${claim(c).replaceAll('\u00a0', ' ')}. ${c.lead}`,
    `Canonical page: ${url(c.path)}`,
    `## A month at each size`,
    `${c.assume} Monthly billing, no promotions. ${vendor}’s prices checked ${dayOf(c.offer.checked)} on [${host(c.offer.pricing)}](${c.offer.pricing}).`,
    table(head, rows, sizeHead.map((_, i) => i).concat([sizeHead.length, sizeHead.length + 1])),
    `${productName} charges ${nightmail.perThousand} per 1,000 emails after ${free} free a month.`,
    `## What ${productName} has that ${vendor} charges for or lacks`,
    c.rows.map(row => `- ${row.text}${row.source ? ` ([${host(row.source.url)}](${row.source.url}), checked ${dayOf(row.source.checked)})` : ''}`).join('\n'),
    `## Also in the box`,
    c.panels.map(id => `- **${PANELS[id].title}** ${PANELS[id].line}`).join('\n'),
    ...c.without?.length ? [`Not in the box: ${listOf(c.without)}.`] : [],
    FIRST_STEP[c.focus],
    ...c.faq?.length ? [`## Questions`, c.faq.map(item => `### ${item.question}\n\n${item.answer}`).join('\n\n')] : [],
    `## ${productName}’s pricing terms`,
    terms(),
    `## Sources`,
    pagesRead(c).map(source => `- [${host(source.url)}${new URL(source.url).pathname.replace(/\/$/, '')}](${source.url}), checked ${dayOf(source.checked)}`).join('\n'),
    trademarks,
    `## More`,
    `- [Price calculator](${url('/pricing.md')}): ${productName} and the other vendors at your own numbers\n${comparisonLinks(c.slug)}`,
  ].join('\n\n') + '\n'
}

/** The calculator's three sizes (content.tsx, PRESETS: Small, Medium and Large, the Mailchimp comparison's). */
const PRESETS: [string, Usage][] = (['Small', 'Medium', 'Large'] as const).map((name, i) => [name, COMPARISONS.find(c => c.slug === 'mailchimp')!.sizes[i]!])
export function pricingMarkdown(): string {
  const vendors = [...new Set(OFFERS.map(offer => offer.name))]
  const rows = PRESETS.map(([name, u]) => {
    const priced = vendorRows(OFFERS, u)
    return [name, formatCount(u.sent), formatCount(u.received), formatCount(u.contacts), formatCount(u.seats), nightmailBill(u.sent, u.received).text,
      ...vendors.map(vendor => { const row = priced.find(r => r.offer.name === vendor); return row ? `${money(row.cents)} (${row.plan})` : 'no price read' })]
  })
  const checked = [...new Map(OFFERS.map(offer => [offer.pricing, offer.checked])).entries()].map(([page, day]) => `[${host(page)}](${page}) on ${dayOf(day)}`)
  const [, medium] = PRESETS[1]!, bill = nightmailBill(medium.sent, medium.received)
  return [
    `# ${productName} price calculator`,
    `> What ${productName} costs at your size, beside ${listOf(vendors)}. ${nightmail.perThousand} per 1,000 emails; contacts and teammates are free.`,
    `Canonical page: ${url('/pricing')}`,
    `## How ${productName} charges`,
    terms(),
    `At ${formatCount(medium.sent)} emails sent and ${formatCount(medium.received)} received a month: sent ${billMath(bill.sent)} = ${bill.sent.text}; received ${billMath(bill.received)} = ${bill.received.text}; ${bill.text} a month.`,
    `## A month at three sizes`,
    `Each vendor’s cheapest plan that holds the numbers, list price before tax, monthly billing, no promotions. Prices checked on ${listOf(checked)}.`,
    table(['Size', 'Sent', 'Received', 'Contacts', 'Teammates', productName, ...vendors], rows, [1, 2, 3, 4, 5]),
    `Any other numbers: ${url('/pricing')}?sent=…&received=…&contacts=…&teammates=… (each a whole number) opens the calculator on them.`,
    `## Comparisons`,
    comparisonLinks(),
    trademarks,
  ].join('\n\n') + '\n'
}

export function homeMarkdown(): string {
  return [
    `# ${productName}`,
    `> ${productName} is an email API on Amazon SES: send, receive and reply on your own domains. ${nightmail.perThousand} per 1,000 emails, sent or received via API. Free every month: ${free}.`,
    `Canonical page: ${url('/')}`,
    `## What it costs`,
    terms(),
    `That’s the whole bill. [Price calculator](${url('/pricing.md')})`,
    `## What it does`,
    PANEL_IDS.map(id => `- **${PANELS[id].title}** ${PANELS[id].line}`).join('\n'),
    `## Compared`,
    comparisonLinks(),
    `## For developers and agents`,
    `- [API documentation for agents](${url('/docs.md')}): quickstart, guides and every operation\n- [OpenAPI 3.1](${url('/openapi.json')})\n- [Agent index](${url('/llms.txt')})`,
  ].join('\n\n') + '\n'
}

/** Each public page's Markdown twin, by its file in the build. */
export function markdownFiles(): { file: string; source: string }[] {
  return [
    { file: 'index.md', source: homeMarkdown() },
    ...PRICE_PAGES.map(page => ({ file: markdownPath(page.path).slice(1), source: page.comparison ? comparisonMarkdown(page.comparison) : pricingMarkdown() })),
  ]
}

/** llms.txt's lines for the site's own pages (the API puts them under its title: api/src/site-index.ts). */
export function llmsSiteIndex(): string {
  return [
    `## Product and pricing`,
    `- [${productName}](${url('/index.md')}): what it does and what it costs\n- [Price calculator](${url('/pricing.md')}): ${productName} beside ${listOf([...new Set(OFFERS.map(offer => offer.vendor))])} at three sizes, and how to price any other\n- [The website in full](${url('/llms-full.txt')}): these pages and every comparison, in one file`,
    `## Comparisons`,
    comparisonLinks(),
  ].join('\n\n') + '\n\n'
}
/** llms-full.txt: every page's Markdown twin, one after another. */
export function llmsFull(): string {
  return [`# ${productName}: the website in full`, `> The homepage, the price calculator and every comparison, as Markdown. API documentation: ${url('/docs.md')}.`, ...markdownFiles().map(({ source }) => source.trim().replace(/^# /, '## ').replace(/\n(#{2,5}) /g, '\n#$1 '))].join('\n\n') + '\n'
}

// ---------------------------------------------------------------- structured data (JSON-LD)

const app = () => ({
  '@type': 'SoftwareApplication', '@id': url('/#app'), name: productName, url: url('/'),
  applicationCategory: 'BusinessApplication', applicationSubCategory: 'Email API', operatingSystem: 'Web',
  description: `An email API on Amazon SES: send, receive and reply on your own domains. ${nightmail.perThousand} per 1,000 emails, sent or received, after ${free} free every month.`,
  offers: {
    '@type': 'Offer', price: nightmail.perThousand.slice(1), priceCurrency: 'USD', url: url('/pricing'),
    description: `${nightmail.perThousand} per 1,000 emails, sent or received, after ${free} free every month. Contacts and teammates: no charge.`,
    priceSpecification: { '@type': 'UnitPriceSpecification', price: nightmail.perThousand.slice(1), priceCurrency: 'USD', referenceQuantity: { '@type': 'QuantitativeValue', value: 1000, unitText: 'emails' } },
  },
})
const site = () => ({ '@type': 'WebSite', '@id': url('/#website'), name: productName, url: url('/') })
/** A page's JSON-LD: the page, the product it's about with its price, and the questions it answers. */
export function structuredData(page: Pick<PricePage, 'path' | 'title' | 'description' | 'comparison'> | 'home'): object {
  if (page === 'home') return { '@context': 'https://schema.org', '@graph': [site(), app()] }
  const c = page.comparison
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', '@id': url(page.path), url: url(page.path), name: page.title, description: page.description, inLanguage: 'en',
        isPartOf: { '@id': url('/#website') }, about: { '@id': url('/#app') },
        ...c ? { dateModified: lastChecked(c), mentions: { '@type': 'SoftwareApplication', name: c.vendor, url: c.offer.pricing }, citation: pagesRead(c).map(source => source.url) } : {} },
      site(), app(),
      ...c?.faq?.length ? [{ '@type': 'FAQPage', '@id': url(`${page.path}#questions`), mainEntity: c.faq.map(item => ({ '@type': 'Question', name: item.question, acceptedAnswer: { '@type': 'Answer', text: item.answer } })) }] : [],
    ],
  }
}
/** JSON-LD as a script element's text: "<" escaped, so no value can end the element. */
export const jsonLd = (data: object) => JSON.stringify(data).replaceAll('<', '\\u003c')
