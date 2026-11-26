// (With extensions: the build's config imports this file, through pages.ts and readable.ts.)
import { productName, publicOrigin } from '../../../../../api/src/brand.ts'
import type { WorkspaceFocus } from '../../../../../api/src/workspace-focus.ts'
import { dayOf, type Source } from '../prices.ts'

// A public page that answers a question about email prices (docs/: a vendor's pricing page, vendor-pricing.ts), as one
// piece of data: its address, its title and description, its answer, its sections, its questions, its sources and its
// links. Everything a reader or a crawler gets is made from it: the page itself (page.tsx, in whichever look the pages
// have), its Markdown twin (docMarkdown), its structured data (docGraph) and its line in llms.txt (Doc.llms), so the page
// and its copies can't say different things, and the look can change without a word of it changing.

/** A run of words: text, a link (a site path, or a vendor's https page), or a Nightmail figure marked with the usage it
 *  prices (data-nightmail-sent and -received on the page, which api/scripts/check-premerge.ts reads back). */
export type Inline = string | { text: string; href: string } | { ours: string; sent: number; received: number }
export type Text = Inline[]
export type Table = {
  kind: 'table'
  /** What the figures assume and where they were read: said with the table, beside its numbers, not only in the small print. */
  caption: Text
  head: string[]
  rows: { cells: Text[]; mark?: boolean }[]
  /** The columns whose figures align right. */
  numeric: number[]
}
export type Block = { kind: 'p'; text: Text } | { kind: 'list'; items: Text[] } | Table
export type Section = { id: string; title: string; blocks: Block[] }
/** A question the page answers, word for word as the page shows it and its FAQPage carries it (the comparisons' shape:
 *  pricing/questions.ts). */
export type Question = { id: string; question: string; answer: string }
export type Doc = {
  path: string
  /** The page's name on the site, and its title in search results and link previews (at most 60 characters). */
  title: string
  searchTitle: string
  /** 140 to 160 characters. */
  description: string
  h1: string
  /** What the page opens on: two lines of a handful of words each (the vendor's price, then Nightmail's for the same mail)
   *  and one small caption with what they assume and the day they were read. */
  verdict: { lines: [Text, Text]; caption: string }
  /** The fuller answer, the figures an assistant would quote: the Markdown twin's opening lines after the verdict. On the
   *  page they are in its first table. */
  answer: Text[]
  sections: Section[]
  questions: Question[]
  /** Every page a figure was read on, once each, with the day. */
  sources: Source[]
  /** The other pages about the same thing, each a line: the vendor's comparison, its other pages, the calculator. */
  related: { title: string; path: string; line: string }[]
  /** Where the page sits (Home › …), for the breadcrumb it shows and its BreadcrumbList. */
  crumbs: { name: string; path: string }[]
  /** What the page is about: the vendor and its pricing page. */
  about: { name: string; url: string }
  /** The last day any figure on it was read (the sitemap's lastmod, the page's dateModified). */
  modified: string
  focus: WorkspaceFocus
  /** The page's line in llms.txt, after its link. */
  llms: string
}

const url = (path: string) => publicOrigin + path
const host = (page: string) => new URL(page).hostname.replace(/^www\./, '')
/** A vendor's page as the sources name it: its host and path. */
export const pageName = (page: string) => host(page) + new URL(page).pathname.replace(/\/$/, '')
/** A site path's Markdown twin, the way the twins link one another. */
const twin = (path: string) => url(path === '/' ? '/index.md' : `${path.replace(/[?#].*$/, '')}.md`)
/** The words of a run, without links: a title, an alt text, an FAQ answer. */
export const plain = (text: Text) => text.map(part => typeof part === 'string' ? part : 'href' in part ? part.text : part.ours).join('')
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
  if (b.kind === 'list') return b.items.map(item => `- ${inline(item)}`).join('\n')
  return [inline(b.caption), [
    `| ${b.head.join(' | ')} |`, `| ${b.head.map((_, i) => b.numeric.includes(i) ? '---:' : '---').join(' | ')} |`,
    ...b.rows.map(row => `| ${row.cells.map(text => cell(inline(text))).join(' | ')} |`),
  ].join('\n')].join('\n\n')
}

/** The page in Markdown (/<path>.md): its headline and answer first, every section, the questions, the sources and the
 *  small print, then the related pages under More (which llms-full.txt leaves out, as it does the comparisons'). */
export function docMarkdown(doc: Doc): string {
  return [
    `# ${doc.h1}`,
    [[...doc.verdict.lines[0], ' ', ...doc.verdict.lines[1], ' ', doc.verdict.caption], ...doc.answer].map(paragraph => `> ${inline(paragraph)}`).join('\n>\n'),
    `Canonical page: ${url(doc.path)}`,
    ...doc.sections.flatMap(section => [`## ${section.title}`, ...section.blocks.map(block)]),
    ...doc.questions.length ? ['## Questions', doc.questions.map(item => `### ${item.question}\n\n${item.answer}`).join('\n\n')] : [],
    '## Sources',
    pagesOf(doc.sources).map(source => `- [${pageName(source.url)}](${source.url}), read ${dayOf(source.checked)}`).join('\n'),
    trademarks,
    '## More',
    doc.related.map(page => `- [${page.title}](${twin(page.path)}): ${page.line}`).join('\n'),
  ].join('\n\n') + '\n'
}

/** A page's FAQPage: its questions word for word as the page shows them. (The comparisons' is pricing/questions.ts's
 *  faqPage, the same shape.) */
export const faqPage = (pageUrl: string, questions: Question[]) => ({
  '@type': 'FAQPage', '@id': `${pageUrl}#questions`,
  mainEntity: questions.map(item => ({ '@type': 'Question', name: item.question, acceptedAnswer: { '@type': 'Answer', text: item.answer } })),
})
/** The page's own nodes for its JSON-LD (readable.ts adds the site's and the product's): the page, with the day its
 *  figures were last read, what it is about and the pages it cites; where it sits; and the questions it shows. Nothing
 *  it doesn't say: no offers, ratings or reviews for anyone. */
export function docGraph(doc: Doc): object[] {
  const page = url(doc.path)
  return [
    { '@type': 'WebPage', '@id': page, url: page, name: doc.searchTitle, description: doc.description, inLanguage: 'en',
      isPartOf: { '@id': url('/#website') }, dateModified: doc.modified, breadcrumb: { '@id': `${page}#breadcrumb` },
      about: { '@type': 'SoftwareApplication', name: doc.about.name, url: doc.about.url }, mentions: { '@id': url('/#app') },
      citation: pagesOf(doc.sources).map(source => source.url) },
    { '@type': 'BreadcrumbList', '@id': `${page}#breadcrumb`, itemListElement: doc.crumbs.map((crumb, i) => ({ '@type': 'ListItem', position: i + 1, name: crumb.name, item: url(crumb.path) })) },
    ...doc.questions.length ? [faqPage(page, doc.questions)] : [],
  ]
}
