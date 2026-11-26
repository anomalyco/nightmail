import { Fragment } from 'react'
import { Link } from 'react-router'
import { SignInConsent } from '../../../components/LegalLinks'
import { WaitlistLine } from '../../home/get-started'
import { Hall, keys, PageEnd, type Start } from '../board'
import { Ours } from '../content'
import { dayOf } from '../prices'
import { pageName, pagesOf, trademarks, type Block, type Doc, type Text } from './doc'

// A pricing page (docs/doc.ts) in the price pages' look (board.css, docs.css; prerender.tsx paints it, doc-page.tsx is the
// app's), until the pages' new look draws the same data: under the lamp, the page's name, the verdict in two lines and
// its caption, and a small Get started; then the tables, the questions and the related pages; then Sources. Every word
// is the page's data: nothing here adds a figure or a claim. (No styles imported here, so the build and the pre-merge
// check can render it.)

/** A run of words: text, links (a site page in the app, a vendor's page in a new tab) and Nightmail's figures, marked. */
export function Words({ text }: { text: Text }) {
  return <>{text.map((part, i) => <Fragment key={i}>{typeof part === 'string' ? part
    : 'href' in part ? part.href.startsWith('/') ? <Link to={part.href}>{part.text}</Link> : <a href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
      : <Ours sent={part.sent} received={part.received}>{part.ours}</Ours>}</Fragment>)}</>
}

/** A table: on a phone each row is a card, each figure under its column's name (data-label, docs.css). */
function DocTable({ table, id }: { table: Extract<Block, { kind: 'table' }>; id: string }) {
  return <div className="doc-table-wrap" role="region" aria-labelledby={`${id}-title`} tabIndex={0}>
    <table className="doc-table">
      <caption><Words text={table.caption} /></caption>
      <thead><tr>{table.head.map((head, i) => <th key={head} scope="col" data-num={table.numeric.includes(i) || undefined}>{head}</th>)}</tr></thead>
      <tbody>{table.rows.map((row, r) => <tr key={r} data-mark={row.mark || undefined}>{row.cells.map((cell, i) => i === 0
        ? <th key={i} scope="row" data-label={table.head[i]} data-num={table.numeric.includes(i) || undefined}><Words text={cell} /></th>
        : <td key={i} data-label={table.head[i]} data-num={table.numeric.includes(i) || undefined}><Words text={cell} /></td>)}</tr>)}</tbody>
    </table>
  </div>
}
function DocBlock({ block, id }: { block: Block; id: string }) {
  if (block.kind === 'p') return <p className="doc-p"><Words text={block.text} /></p>
  if (block.kind === 'list') return <ul className="doc-list">{block.items.map((item, i) => <li key={i}><Words text={item} /></li>)}</ul>
  return <DocTable table={block} id={id} />
}

/** The hall's stage: the page's place (its breadcrumb), its name, the verdict and its caption, and the way in. */
export function DocScene({ doc, start }: { doc: Doc; start?: Start }) {
  return <Hall page={doc.path} below={<DocBelow doc={doc} />}>
    <nav className="doc-crumbs" aria-label="Breadcrumb"><ol>{doc.crumbs.map((crumb, i) => <li key={crumb.path}>
      {i === doc.crumbs.length - 1 ? <span aria-current="page">{crumb.name}</span> : <Link to={crumb.path}>{crumb.name}</Link>}
    </li>)}</ol></nav>
    <h1 id="cb-title" className="doc-h1">{doc.h1}</h1>
    <p className="doc-verdict"><span className="doc-theirs"><Words text={doc.verdict.lines[0]} /></span> <span className="doc-ours"><Words text={doc.verdict.lines[1]} /></span></p>
    <p className="doc-caption">{doc.verdict.caption}</p>
    {start && <div className="doc-way" {...keys}>
      {start.button('cb-key cb-key-start doc-key')}
      {!start.signedIn && <><SignInConsent className="cb-consent doc-consent" /><WaitlistLine className="cb-consent doc-consent cb-full" full={start.full} /></>}
    </div>}
  </Hall>
}

/** Under the stage: the sections, the questions and the related pages, one column on the wall's dark. */
function DocBelow({ doc }: { doc: Doc }) {
  return <div className="doc-body">
    {doc.sections.map(section => <section key={section.id} id={section.id} className="doc-section" aria-labelledby={`${section.id}-title`}>
      <h2 id={`${section.id}-title`} className="doc-h2">{section.title}</h2>
      {section.blocks.map((block, i) => <DocBlock key={i} block={block} id={section.id} />)}
    </section>)}
    {doc.questions.length ? <section id="questions" className="doc-section cb-faq" aria-labelledby="questions-title">
      <h2 id="questions-title" className="doc-h2">Questions</h2>
      <dl>{doc.questions.map(item => <div key={item.id}><dt>{item.question}</dt><dd>{item.answer}</dd></div>)}</dl>
    </section> : null}
    <nav className="doc-section" aria-labelledby="more-title">
      <h2 id="more-title" className="doc-h2">More</h2>
      <ul className="doc-related">{doc.related.map(page => <li key={page.path}><Link to={page.path}>{page.title}</Link><span>{page.line}</span></li>)}</ul>
    </nav>
  </div>
}

/** The page's end: every page its figures were read on, with the day, and the trademark line; then the site's end. */
export function DocEnd({ doc }: { doc: Doc }) {
  const pages = pagesOf(doc.sources)
  return <PageEnd here={doc.path}>
    <section className="cb-sources" id="sources" aria-labelledby="sources-title">
      <h2 id="sources-title" className="cb-sources-title">Sources</h2>
      <p className="price-note cb-read">Pages read: {pages.map((source, i) => <Fragment key={source.url}>{i > 0 && (i === pages.length - 1 ? ' and ' : ', ')}<a href={source.url} target="_blank" rel="noopener noreferrer">{pageName(source.url)}</a> on {dayOf(source.checked)}</Fragment>)}.</p>
      <p className="price-note">{trademarks}</p>
    </section>
  </PageEnd>
}
