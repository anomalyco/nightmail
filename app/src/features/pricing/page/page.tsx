import { Fragment, type CSSProperties, type ReactNode } from 'react'
import { SignInConsent } from '../../../components/LegalLinks'
import { NightmailWordmark } from '../../../components/NightmailLogo'
import type { Start } from '../board'
import { dayOf, type Source } from '../prices'
import { answerRuns, linesOf, plain, type Block, type Inline, type PageDoc, type Question, type Table, type Text } from './shape'

// A public price page, drawn from its data (shape.ts): a comparison (comparison.ts), the comparisons' index (hub.ts), or
// any page made in that shape. The verdict first, in the homepage television's type and colours on its room's dark: the
// heading's lines, Nightmail's in the screen's periwinkle, a small caption with the size and the day, and the way in, the
// television's airmail label at an ordinary button's size with the sign-in terms under it. Then the page's sections (the
// first, the price table, straight under the verdict, its heading for screen readers only), the questions, the related
// pages, and the pages read. app/price-pages.ts writes it as the page's own HTML with its CSS inlined and none of the
// app's code; the app draws the same at the same address (view.tsx). Nothing here may need a browser, and nothing here
// imports a stylesheet or a picture (view.tsx and set.tsx do), so the pre-merge check can render it.

const host = (url: string) => new URL(url).hostname.replace(/^www\./, '')
const pageName = (url: string) => host(url) + new URL(url).pathname.replace(/\/$/, '')

function Run({ text }: { text: Text }) {
  return <>{text.map((part: Inline, i) => typeof part === 'string' ? <span key={i}>{part}</span>
    : 'href' in part ? <a key={i} href={part.href} {...part.href.startsWith('/') ? {} : { target: '_blank', rel: 'noopener noreferrer' }}>{part.text}</a>
      : <span key={i} data-nightmail-sent={part.sent} data-nightmail-received={part.received}>{part.ours}</span>)}</>
}

/** A caption in parts ("Per 100,000 emails a month · checked 25 Nov 2026"): on one line the parts are set apart by a
 *  dot; where they wrap, each wrapped part starts its own line, with no dot (page.css, .pp-parts). The dot and its spaces
 *  are the text's own, so the words read the same to anything that reads them. */
/** A question's answer, its linked words as links (the vendor's pages a line was read on). */
function Answer({ item }: { item: Question }) {
  return <>{answerRuns(item).map((run, i) => typeof run === 'string' ? run : <a key={i} href={run.href}>{run.text}</a>)}</>
}

function Caption({ text }: { text: Text }) {
  const parts = text.length === 1 && typeof text[0] === 'string' ? text[0].split(' · ') : []
  return parts.length < 2 ? <Run text={text} /> : <span className="pp-parts">{parts.map((part, i) => <span key={i}>{i > 0 && <span className="pp-dot">{' · '}</span>}{part}</span>)}</span>
}

/** The way in, the price pages' own (board.tsx, Start): the homepage's button in the television's airmail label
 *  (home/tv/tv.css, .chyp) at an ordinary button's size. Painted (page/prerender.tsx) it is a visitor's Get started; the
 *  app's (view.tsx) signs in with the page's focus, says Join the waitlist when no place is open (home/signups-open.ts),
 *  and is Open dashboard for someone signed in. Under it for a visitor, only the terms signing in agrees to: the button's
 *  own words say when it is a waitlist. */
function Way({ start }: { start?: Start }) {
  if (!start) return null
  return <div className="pp-way">
    <div className="chyp chyp-under pp-label">{start.button('chyp-go')}</div>
    {!start.signedIn && <SignInConsent className="pp-consent" />}
  </div>
}

/** The trademark sentence: in a page's "How we compared" where it has one, else in its small print. */
const TRADEMARKS = 'Product names belong to their owners and only identify their products. Nightmail isn’t affiliated with them.'

/** The heading: each line its own, the first of several in the screen's periwinkle (a verdict leads with Nightmail's),
 *  set as large as its longest line fits the column (--chars, page.css). */
function Heading({ doc, id }: { doc: PageDoc; id?: string }) {
  const lines = linesOf(doc.h1), chars = Math.max(...lines.map(line => plain(line).length))
  return <h1 id={id} className="pp-verdict" style={{ '--chars': chars } as CSSProperties}>{lines.map((line, i) => <span key={i} className="pp-line" data-lead={lines.length > 1 && i === 0 ? '' : undefined}>{i > 0 && ' '}<Run text={line} /></span>)}</h1>
}

/** Where the page sits: the wordmark (home), then each crumb; a crumb carries the slash before it, so a line never ends
 *  on one. */
function Crumbs({ doc }: { doc: PageDoc }) {
  return <header className="pp-top"><nav aria-label="Breadcrumb"><ol className="pp-crumbs">{doc.crumbs.map((crumb, i) => <li key={crumb.path}>
    {i === 0 ? <a href="/" aria-label="nightmail home"><NightmailWordmark /></a> : i === doc.crumbs.length - 1 ? <span aria-current="page">{crumb.name}</span> : <a href={crumb.path}>{crumb.name}</a>}
  </li>)}</ol></nav></header>
}

/** A table: figures right-aligned in the page's mono, a row marked under the screen's blue bar (the size the verdict
 *  quotes), a row with a Nightmail figure in periwinkle. A last column of words (a plan's name) folds under the figures
 *  on a phone. */
function TableBlock({ table, sources = [] }: { table: Table; sources?: Source[] }) {
  const last = table.head.length - 1, fold = table.head.length > 3 && !table.numeric.includes(last), ours = table.head.indexOf('Nightmail')
  const align = (i: number) => table.numeric.includes(i) ? 'end' : undefined
  return <><table className="pp-table" data-fold={fold ? '' : undefined}>
    {table.caption.length > 0 && <caption><Run text={table.caption} /></caption>}
    <thead><tr>{table.head.map((head, i) => <th key={i} scope="col" data-align={align(i)} data-ours={i === ours ? '' : undefined} data-last={fold && i === last ? '' : undefined}>{head}</th>)}</tr></thead>
    <tbody>{table.rows.map((row, r) => <tr key={r} data-mark={row.mark ? '' : undefined}>{row.cells.map((cell, i) => i === 0
      ? <th key={i} scope="row"><Run text={cell} /></th>
      : <td key={i} data-align={align(i)} data-ours={i === ours ? '' : undefined} data-last={fold && i === last ? '' : undefined}><Run text={cell} /></td>)}</tr>)}</tbody>
  </table>
  {/* The whole note, closed: everything that makes the figures honest, in the page's HTML, out of a reader's way. */}
  {table.method && <details className="pp-qa pp-method"><summary><span className="pp-qa-q">How we compared</span></summary>
    <p><Run text={table.method} /></p>{sources.length > 0 && <Checked sources={sources} />}<p>{TRADEMARKS}</p>
  </details>}</>
}
function BlockView({ block, sources }: { block: Block; sources?: Source[] }) {
  if (block.kind === 'p') return <p className="pp-p"><Run text={block.text} /></p>
  if (block.kind === 'list') return <ul className="pp-list">{block.items.map((item, i) => <li key={i}><Run text={item} /></li>)}</ul>
  return <TableBlock table={block} sources={sources} />
}

/** The pages read, by day: "Checked 25 Nov 2026 on resend.com/pricing." */
function Checked({ sources }: { sources: Source[] }) {
  const pages = [...new Map(sources.map(source => [source.url, source])).values()]
  const days = [...new Set(pages.map(source => source.checked))].sort()
  const join = (i: number, n: number) => i === 0 ? '' : i === n - 1 ? ' and ' : ', '
  // (Each day's words one text, so the HTML reads "Checked 25 Nov 2026 on <a …>", as the pre-merge check looks for it.)
  return <p>{days.map((day, d) => { const on = pages.filter(source => source.checked === day); return <Fragment key={day}>{`${d === 0 ? 'Checked ' : '; '}${dayOf(day)} on `}{on.map((source, i) => <Fragment key={source.url}>{join(i, on.length)}<a href={source.url} target="_blank" rel="noopener noreferrer">{pageName(source.url)}</a></Fragment>)}</Fragment> })}.</p>
}

// (Home is the wordmark at the top; API docs last, the first to go when a row would pass six.)
const SITE_LINKS = [{ title: 'Pricing', path: '/pricing' }, { title: 'Compare', path: '/compare' }, { title: 'Terms', path: '/legal/terms' }, { title: 'Privacy', path: '/legal/privacy' }, { title: 'API docs', path: '/docs' }]

export function PricePageView({ doc, set, start }: { doc: PageDoc; set?: ReactNode; start?: Start }) {
  const method = doc.sections.flatMap(section => section.blocks).find(block => block.kind === 'table' && block.method), folded = method !== undefined
  // At most six, the page's own related pages first; /compare keeps all of its own (the index of the vendor and use pages).
  const links = [...doc.related, ...SITE_LINKS].filter((link, i, all) => link.path !== doc.path && all.findIndex(other => other.path === link.path) === i).slice(0, doc.path === '/compare' ? undefined : 6)
  return <div className="pp" data-set={set ? '' : undefined}>
    <Crumbs doc={doc} />
    {set}
    <main className="pp-col">
      <section className="pp-hero" aria-labelledby="pp-h1">
        <Heading doc={doc} id="pp-h1" />
        {(doc.caption ? [doc.caption] : doc.answer).map((text, i) => <p key={i} className="pp-caption"><Caption text={text} /></p>)}
        <Way start={start} />
      </section>
      {doc.sections.map((section, i) => <section key={section.id} id={section.id} className="pp-section" aria-labelledby={`${section.id}-title`}>
        {/* Quiet, or a page's only section and a table (a vendor's price page): its title for screen readers only. */}
        <h2 id={`${section.id}-title`} className={section.quiet || (doc.sections.length === 1 && section.blocks[0]?.kind === 'table') ? 'sr-only' : 'pp-h2'}>{section.title}</h2>
        {/* The pages read go in the first table's How we compared, where it has one. */}
        {section.blocks.map((block, j) => <BlockView key={j} block={block} sources={block === method ? doc.sources : undefined} />)}
      </section>)}
      {doc.questions.length > 0 && <section id="questions" className="pp-section" aria-labelledby="questions-title">
        <h2 id="questions-title" className="pp-h2">Questions</h2>
        {/* Each a closed row that opens on a tap or a key: the answers stay in the HTML (the FAQPage carries them word for
            word), out of a visitor's way. */}
        {doc.questions.map(item => <details key={item.id} className="pp-qa"><summary><h3>{item.question}</h3></summary><p><Answer item={item} /></p></details>)}
      </section>}
      {!folded && <footer className="pp-print">
        {doc.sources.length > 0 && <Checked sources={doc.sources} />}
        <p>{TRADEMARKS}</p>
      </footer>}
    </main>
    {/* One quiet row: the page's related pages, then the site's, each once. */}
    <footer className="pp-end"><nav aria-label="More pages">
      {links.map(link => <a key={link.path} href={link.path}>{link.title}</a>)}
    </nav></footer>
  </div>
}
