// The legal pages (src/features/legal/content/*.md), rendered to HTML when the dashboard builds: a front matter block
// (title, description, updated, effective) and Markdown. Every heading gets a stable id from its words without the
// section number ("5.7 Refunds and credit expiry" is #refunds-and-credit-expiry, so renumbering never breaks a link)
// and a hover anchor; prose gets curly quotes and apostrophes; a table scrolls inside its own box on a phone.
// The source is ours and trusted, so the HTML is rendered as is.
//
// Announced changes (api/src/policy-changes.ts): the front matter's `changes` names those a document carries, and its
// Markdown says them for both sides of the day they take effect:
//   {{date name}}, {{announced name}}   the day it takes effect, the day it was announced ("4 January 2027")
//   {{before name: words}}               words only before that day
//   {{after name: words}}                words only from that day on
// Each side is true on every day, so a page built before the day and served after it is still true; the first build from
// that day on keeps only the later words. The document is updated on the day a change was announced, and updated and
// effective on the day it takes effect.
import { Marked, type Tokens } from 'marked'
import type { Plugin } from 'vite'
import { isPolicyChange, POLICY_CHANGES, policyDay, policyInEffect, type PolicyChange } from '../api/src/policy-changes.ts'

export type LegalHeading = { id: string; depth: number; html: string }
export type LegalDocument = { title: string; description: string; updated: string; effective: string; html: string; headings: LegalHeading[] }

const DAY = 86_400_000
const DAY_WORD = /\{\{(date|announced) (\w+)\}\}/g, SIDE = /\{\{(before|after) (\w+): ?([\s\S]*?)\}\}/g
/** A document's announced changes said for `now`'s side of each, and the dates that gives it. */
function resolveChanges(body: string, names: string[], dates: { updated: string; effective: string }, file: string, now: number) {
  const unknown = names.find(name => !isPolicyChange(name))
  if (unknown) throw new Error(`${file}: front matter names ${unknown} in changes, which isn't in api/src/policy-changes.ts`)
  const changes = names as PolicyChange[], said = new Set<string>()
  for (const change of changes) {
    const { announced, from } = POLICY_CHANGES[change], start = Date.parse(from)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(announced) || Number.isNaN(start) || start % DAY) throw new Error(`policy-changes.ts: ${change} needs announced as YYYY-MM-DD and from at 00:00 UTC`)
    if (start - Date.parse(announced) < 31 * DAY) throw new Error(`policy-changes.ts: ${change} takes effect less than 31 days after it was announced (${announced} to ${from}); customers get at least 30 days' notice`)
  }
  const listed = (name: string) => { if (!(changes as string[]).includes(name)) throw new Error(`${file}: says ${name} without naming it in the front matter's changes`); said.add(name); return name as PolicyChange }
  const markdown = body
    .replace(DAY_WORD, (_word, kind: string, name: string) => { const { announced, from } = POLICY_CHANGES[listed(name)]; return policyDay(kind === 'date' ? from : announced) })
    .replace(SIDE, (_words, side: string, name: string, words: string) => (side === 'after') === policyInEffect(listed(name), now) ? words : '')
  if (/\{\{|\}\}/.test(markdown)) throw new Error(`${file}: a {{…}} that isn't an announced change's date or its before or after words`)
  const quiet = changes.find(change => !said.has(change))
  if (quiet) throw new Error(`${file}: names ${quiet} in changes but says nothing of it`)
  const latest = (...days: string[]) => days.reduce((a, b) => Date.parse(b) > Date.parse(a) ? b : a)
  const days = changes.map(change => POLICY_CHANGES[change]), inEffect = days.filter(({ from }) => Date.parse(from) <= now).map(({ from }) => policyDay(from))
  return { markdown, updated: latest(dates.updated, ...days.map(day => policyDay(day.announced)), ...inEffect), effective: latest(dates.effective, ...inEffect) }
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// Straight quotes to curly: an opening quote follows the start, a space or an opening bracket; anything else closes.
const smart = (text: string) => text.replace(/(^|[\s([{—-])"/g, '$1“').replace(/"/g, '”').replace(/(^|[\s([{—-])'/g, '$1‘').replace(/'/g, '’')
const plain = (text: string) => text.replace(/<[^>]+>/g, '').replace(/[*_`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
const slug = (text: string) => plain(text).toLowerCase().replace(/^(\d+(\.\d+)*\.?|\([a-z]\))\s+/, '').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function frontMatter(source: string, file: string) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source)
  if (!match) throw new Error(`${file}: missing front matter`)
  const fields = Object.fromEntries(match[1]!.split('\n').map(line => { const at = line.indexOf(':'); return [line.slice(0, at).trim(), line.slice(at + 1).trim()] }))
  for (const key of ['title', 'description', 'updated', 'effective']) if (!fields[key]) throw new Error(`${file}: front matter needs ${key}`)
  return { fields: fields as Record<'title' | 'description' | 'updated' | 'effective', string> & { changes?: string }, body: source.slice(match[0].length) }
}

/** `markdown`: the document's Markdown as this build says it (its announced changes resolved), for its Markdown twin. */
export function renderLegal(source: string, file: string, now = Date.now()): LegalDocument & { markdown: string } {
  const { fields: { title, description, changes, ...dates }, body: written } = frontMatter(source.replace(/\r\n/g, '\n'), file)
  const { markdown: body, updated, effective } = resolveChanges(written, changes ? changes.split(',').map(name => name.trim()) : [], dates, file, now)
  const headings: LegalHeading[] = [], used = new Set<string>()
  const marked = new Marked({ gfm: true, renderer: {
    text(token: Tokens.Text | Tokens.Escape) { return 'tokens' in token && token.tokens ? this.parser.parseInline(token.tokens) : 'escaped' in token && token.escaped ? token.text : escape(smart(token.text)) },
    heading({ tokens, depth, text }: Tokens.Heading) {
      const html = this.parser.parseInline(tokens)
      let id = slug(text) || 'section'
      for (let n = 2; used.has(id); n++) id = `${slug(text)}-${n}`
      used.add(id)
      headings.push({ id, depth, html })
      return `<h${depth} id="${id}">${html}<a class="legal-anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`
    },
    table(token: Tokens.Table) {
      const cell = (c: Tokens.TableCell) => this.parser.parseInline(c.tokens)
      const head = `<tr>${token.header.map(c => `<th scope="col">${cell(c)}</th>`).join('')}</tr>`
      const rows = token.rows.map(row => `<tr>${row.map(cell).map(html => `<td>${html}</td>`).join('')}</tr>`).join('\n')
      return `<div class="legal-table"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>\n`
    },
    link({ href, tokens }: Tokens.Link) {
      const external = /^https?:/.test(href)
      return `<a href="${escape(href)}"${external ? ' rel="noopener"' : ''}>${this.parser.parseInline(tokens)}</a>`
    },
  } })
  const html = marked.parse(body, { async: false })
  if (headings.length === 0 || headings.some(h => h.depth === 1)) throw new Error(`${file}: use ## headings and below; the title comes from the front matter`)
  return { title, description, updated, effective, html, headings, markdown: body }
}

// Each legal page's Markdown becomes { title, description, updated, effective, html, headings } at build time, so the page
// ships HTML and no Markdown parser: in the app's build (vite.config.ts) and where site-pages.ts draws the pages.
export const legalMarkdown = (): Plugin => ({
  name: 'nightmail:legal-markdown',
  transform(source, id) {
    if (!id.endsWith('.md')) return null
    const { markdown: _markdown, ...document } = renderLegal(source, id)
    return { code: `export default ${JSON.stringify(document)}`, map: null }
  },
})
