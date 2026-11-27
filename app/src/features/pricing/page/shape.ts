// (With extensions: the build's config imports this file, through comparison.ts and hub.ts.)
import type { WorkspaceFocus } from '../../../../../api/src/workspace-focus.ts'
import type { Source } from '../prices.ts'

// A public price page as one piece of data, which page.tsx draws: the shape the other price pages are made in (the
// seo/pricing-pages branch's docs/doc.ts, Doc), so a comparison (comparison.ts), the comparisons' index (hub.ts) and those
// pages (a vendor's pricing, alternatives, ranked lists) are all drawn by the same renderer. The same field names and
// types, structurally: a Doc from there is a PageDoc here. Two additions: h1 may be lines (the verdict's two), in which a
// Nightmail figure is marked (Inline's `ours`), so the renderer can set Nightmail's line apart (a plain string still is
// one); and a section may be quiet (its title for screen readers only).
// Once doc.ts lands, this file becomes `export type { … } from '../docs/doc.ts'` with that addition made there.

/** A run of words: text, a link (a site path, or a vendor's https page), or a Nightmail figure marked with the usage it
 *  prices (data-nightmail-sent and -received on the page, which api/scripts/check-premerge.ts reads back). */
export type Inline = string | { text: string; href: string } | { ours: string; sent: number; received: number }
export type Text = Inline[]
export type Table = {
  kind: 'table'
  /** What the figures assume and where they were read: said with the table. With a method, empty: the note is all in
   *  How we compared (docs/index.ts checks it). */
  caption: Text
  /** The full note on how the figures were read (which services, the basis, the rates, the day, the pages): in a closed
   *  "How we compared" under the table (page.tsx), and in place of the caption in the Markdown twin (docs/doc.ts). */
  method?: Text
  head: string[]
  rows: { cells: Text[]; mark?: boolean }[]
  /** The columns whose figures align right. */
  numeric: number[]
}
/** A list's full: the longer list the Markdown twin keeps where the page shows a short one (facts.ts, briefFactsSection). */
/** A table as a page shows it: nothing under it but its whole note, folded into "How we compared" (page.tsx; the owner:
 *  "i don't think we need the thing that says list prices before tax"); the Markdown twin keeps the note where the caption
 *  was (docs/doc.ts). */
export const folded = ({ caption, ...table }: Table): Table => ({ caption: [], method: caption, ...table })
export type Block = { kind: 'p'; text: Text } | { kind: 'list'; items: Text[]; full?: Text[] } | Table
/** quiet: its title is for screen readers only (the price table straight under the verdict: page.tsx); a page whose
 *  only section is a table has it so without saying. */
export type Section = { id: string; title: string; blocks: Block[]; quiet?: boolean }
/** A question the page answers, word for word as the page shows it and its FAQPage carries it (pricing/questions.ts).
 *  links: words of the answer that link to a page (the vendor's page a line was read on). */
export type Question = { id: string; question: string; answer: string; links?: Link[] }
export type Link = { text: string; href: string }
/** An answer in runs: its text, with each link's words as a link (the page, the board and the Markdown twins). */
export function answerRuns(item: { answer: string; links?: Link[] }): (string | Link)[] {
  const runs: (string | Link)[] = []
  let rest = item.answer
  for (const link of item.links ?? []) {
    const at = rest.indexOf(link.text)
    if (at < 0) throw new Error(`An answer doesn't say the words it links: ${link.text}`)
    runs.push(rest.slice(0, at), link)
    rest = rest.slice(at + link.text.length)
  }
  return [...runs, rest].filter(run => run !== '')
}
/** The same in Markdown. */
export const answerMarkdown = (item: { answer: string; links?: Link[] }) => answerRuns(item).map(run => typeof run === 'string' ? run : `[${run.text}](${run.href})`).join('')
export type PageDoc = {
  path: string
  title: string
  searchTitle: string
  description: string
  /** The page's one heading: a line, or lines (the verdict: Nightmail's line, then the other's). */
  h1: string | Text[]
  /** The opening lines under it: the size and the day, or the figures an assistant would quote with the day. */
  answer: Text[]
  /** The line under the heading as the page shows it, where it is shorter than answer (at most 10 words, with the day):
   *  answer stays the Markdown twin's, the card's and llms.txt's. */
  caption?: Text
  sections: Section[]
  questions: Question[]
  /** Every page a figure was read on, once each, with the day. */
  sources: Source[]
  /** The other pages about the same thing. */
  related: { title: string; path: string; line: string }[]
  /** Where the page sits (Home › …): the breadcrumb at its top and its BreadcrumbList. */
  crumbs: { name: string; path: string }[]
  about?: { name: string; url: string }
  modified: string
  /** Who Get started signs in for (/overview?focus=…); none on a page for everyone. */
  focus?: WorkspaceFocus
  llms?: string
  card?: { alt: string; shown: string[] }
}

/** The words of a run, without links. */
export const plain = (text: Text) => text.map(part => typeof part === 'string' ? part : 'href' in part ? part.text : part.ours).join('')
/** A heading's lines, whichever way it was given. */
export const linesOf = (h1: PageDoc['h1']): Text[] => typeof h1 === 'string' ? [[h1]] : h1
