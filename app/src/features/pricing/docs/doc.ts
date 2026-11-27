// (With extensions: the build's config imports this file, through pages.ts and readable.ts.)
import { productName, publicOrigin } from '../../../../../api/src/brand.ts'
import type { WorkspaceFocus } from '../../../../../api/src/workspace-focus.ts'
import { answerMarkdown, linesOf, plain, type Block, type PageDoc, type Question, type Section, type Table, type Text } from '../page/shape.ts'
import { dayOf, sourceNote, type Source } from '../prices.ts'
import { faqPage } from '../questions.ts'
import { START } from '../start.ts'

// A public page that answers a question about email prices (docs/: a vendor's pricing page, vendor-pricing.ts), as one
// piece of data in the price pages' shape (page/shape.ts, PageDoc), which page/page.tsx draws as it draws the comparisons.
// Everything a reader or a crawler gets is made from it: the page, its Markdown twin (docMarkdown), its structured data
// (docGraph, with the breadcrumb price-pages.ts adds) and its line in llms.txt, so the page and its copies can't say
// different things.

export type { Block, Inline, Question, Section, Table, Text } from '../page/shape.ts'
export { plain }
export type Doc = PageDoc & {
  /** The heading: the verdict's two lines, Nightmail's (its figure marked) and the vendor's. Under it, `answer`: one dated
   *  line with what they assume. */
  h1: [Text, Text]
  /** The pages the visible table's note links, with the day each was read (the page's own sources: its structured data's
   *  citations). */
  cited: Source[]
  /** What only the Markdown copy carries, for assistants and crawlers: people get the verdict, Get started and one table
   *  (Ryan: "headline, button, comparison underneath"). The vendor's plans, the questions with their answers, every page
   *  read and the other pages of its kind, each fact once. */
  copy: { sections: Section[]; questions: Question[]; sources: Source[]; related: PageDoc['related'] }
  /** The link-preview card's words (app/link-card.ts): two lines of at most 24 characters and a caption of at most 70. */
  cardWords: { lines: [string, string]; caption: string }
  focus: WorkspaceFocus
  about: { name: string; url: string }
  /** The services a page's table lists, in its order: its structured data's ItemList (an alternatives page). */
  items?: { name: string; url: string }[]
  /** A sentence the Markdown copy says first, under the heading (/cheapest-email-api: what its list is and isn't). */
  lead?: string
  llms: string
}

const url = (path: string) => publicOrigin + path
const host = (page: string) => new URL(page).hostname.replace(/^www\./, '')
/** A vendor's page as the sources name it: its host and path. */
export const pageName = (page: string) => host(page) + new URL(page).pathname.replace(/\/$/, '')
/** A site path's Markdown twin, the way the twins link one another. */
const twin = (path: string) => url(path === '/' ? '/index.md' : `${path.replace(/[?#].*$/, '')}.md`)
export { folded } from '../page/shape.ts'
const inline = (text: Text) => text.map(part => typeof part === 'string' ? part : 'href' in part ? `[${part.text}](${part.href.startsWith('/') ? twin(part.href) : part.href})` : part.ours).join('')
const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ')
export const trademarks = `Product names belong to their owners and only identify their products. ${productName} isn’t affiliated with them.`

/** Every page a set of figures was read on, once each, the latest day each was read. */
export const pagesOf = (sources: Source[]) => [...sources.reduce((pages, source) => {
  const known = pages.get(source.url)
  if (!known || known.checked < source.checked) pages.set(source.url, source)
  return pages
}, new Map<string, Source>()).values()]

function block(b: Block): string {
  if (b.kind === 'p') return inline(b.text)
  if (b.kind === 'list') return (b.full ?? b.items).map(item => `- ${inline(item)}`).join('\n')
  return [inline(b.method ?? b.caption), [
    `| ${b.head.join(' | ')} |`, `| ${b.head.map((_, i) => b.numeric.includes(i) ? '---:' : '---').join(' | ')} |`,
    ...b.rows.map(row => `| ${row.cells.map(text => cell(inline(text))).join(' | ')} |`),
  ].join('\n')].join('\n\n')
}

/** The page in Markdown (/<path>.md): its name, the verdict and its caption, the page's table, then what only the copy
 *  carries (the plans, the questions, the sources), the small print, and the related pages under More (which
 *  llms-full.txt leaves out, as it does the comparisons'). */
export function docMarkdown(doc: Doc): string {
  const verdict = [...linesOf(doc.h1).flatMap((line, i) => [...i ? [' '] : [], ...line]), ' ', ...doc.answer.flatMap(line => line)]
  return [
    `# ${doc.title}`,
    `> ${inline(verdict).replaceAll('\u00a0', ' ')}`,
    ...doc.lead ? [doc.lead] : [],
    `Canonical page: ${url(doc.path)}`,
    START,
    ...[...doc.sections, ...doc.copy.sections].flatMap(section => [`## ${section.title}`, ...section.blocks.map(block)]),
    ...doc.copy.questions.length ? ['## Questions', doc.copy.questions.map(item => `### ${item.question}\n\n${answerMarkdown(item)}`).join('\n\n')] : [],
    '## Sources',
    pagesOf(doc.copy.sources).map(source => `- [${pageName(source.url)}](${source.url})${sourceNote(source.url)}, read ${dayOf(source.checked)}`).join('\n'),
    trademarks,
    '## More',
    [...doc.related, ...doc.copy.related].map(page => `- [${page.title}](${twin(page.path)}): ${page.line}`).join('\n'),
  ].join('\n\n') + '\n'
}

/** The page's own nodes for its JSON-LD (readable.ts adds the site's and the product's, price-pages.ts the breadcrumb):
 *  the page, with the day its figures were last read, what it is about and the pages its table cites, and an FAQPage
 *  only for questions a visitor can see (a vendor's pricing page shows none). Nothing it doesn't say: no offers, ratings
 *  or reviews for anyone. */
export function docGraph(doc: Doc): object[] {
  const page = url(doc.path)
  return [
    { '@type': 'WebPage', '@id': page, url: page, name: doc.searchTitle, description: doc.description, inLanguage: 'en',
      isPartOf: { '@id': url('/#website') }, dateModified: doc.modified, breadcrumb: { '@id': `${page}#breadcrumb` },
      about: { '@type': 'SoftwareApplication', name: doc.about.name, url: doc.about.url }, mentions: { '@id': url('/#app') },
      citation: pagesOf(doc.cited).map(source => source.url) },
    ...doc.questions.length ? [faqPage(page, doc.questions)] : [],
    ...doc.items ? [{ '@type': 'ItemList', '@id': `${page}#list`, numberOfItems: doc.items.length, itemListElement: doc.items.map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: item.name, url: item.url })) }] : [],
  ]
}
