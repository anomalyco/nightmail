import { Link } from 'react-router'
import { checkedPhrase, formatCount, nextCheapest, ours, PROVIDERS, short, theirs, TERMS } from './data'

// Option B: the plain table. A month on Nightmail and on every provider at four volumes, Nightmail's row first in large
// figures, the rest under it cheapest first (at 100,000), and the gap to the next cheapest under each column.
const VOLUMES = [10_000, 50_000, 100_000, 1_000_000]
const SORT_AT = 100_000
const rows = PROVIDERS.map(c => ({ c, quotes: VOLUMES.map(v => theirs(c, v)) }))
  .sort((a, b) => (theirs(a.c, SORT_AT)?.usd ?? Infinity) - (theirs(b.c, SORT_AT)?.usd ?? Infinity))
const gaps = VOLUMES.map(v => { const next = nextCheapest(v)!, us = ours(v); return next.q.usd / us.usd })
const times = (n: number) => `${n >= 10 ? Math.floor(n) : Math.floor(n * 10) / 10}×`

export function PriceTable() {
  return <figure className="lc-figure lc-table" aria-labelledby="lc-table-title">
    <p id="lc-table-title" className="lc-figure-title">The lowest price in every column: Nightmail against {PROVIDERS.length} other email APIs, for a month of sending.</p>
    <div className="lc-table-wrap">
      <table>
        <colgroup><col className="lc-col-name" />{VOLUMES.map(v => <col key={v} />)}</colgroup>
        <thead><tr><th scope="col"><span className="lc-long">Emails a month</span><span className="lc-short">Emails</span></th>{VOLUMES.map(v => <th key={v} scope="col"><span className="lc-long">{formatCount(v)}</span><span className="lc-short" aria-hidden="true">{short(v)}</span></th>)}</tr></thead>
        <tbody>
          <tr className="lc-us"><th scope="row">Nightmail</th>{VOLUMES.map(v => <td key={v}>{ours(v).text}</td>)}</tr>
          <tr className="lc-gap"><th scope="row">Next cheapest</th>{gaps.map((gap, i) => <td key={VOLUMES[i]}>{times(gap)}</td>)}</tr>
          {rows.map(({ c, quotes }) => <tr key={c.slug}>
            <th scope="row"><Link to={c.path}>{c.offer.vendor}</Link></th>
            {quotes.map((q, i) => <td key={VOLUMES[i]} title={q ? `${c.offer.vendor}, ${q.plan}` : `${c.offer.vendor} publishes no price at ${formatCount(VOLUMES[i]!)} emails`}>{q ? q.text : '—'}</td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
    <figcaption className="lc-note">“Next cheapest”: how many times Nightmail’s price the cheapest other provider charges. {TERMS} Prices {checkedPhrase()}; each name opens its full comparison and sources.</figcaption>
  </figure>
}
