import { useState, type CSSProperties } from 'react'
import { Link } from 'react-router'
import { formatCount, nextCheapest, ours, PROVIDERS, short, sourceLine, theirs } from './data'

// Option B: the plain table. A month on Nightmail and on every provider at four volumes, Nightmail's row first in large
// figures, the gap to the next cheapest under it, then the providers cheapest first (at 100,000). So Get started is on the
// first screen, the cheapest DESK_ROWS show (PHONE_ROWS on a phone) and "Show all" opens the rest in place.
const VOLUMES = [10_000, 50_000, 100_000, 1_000_000]
const SORT_AT = 100_000, DESK_ROWS = 9, PHONE_ROWS = 5
const rows = PROVIDERS.map(c => ({ c, quotes: VOLUMES.map(v => theirs(c, v)) }))
  .sort((a, b) => (theirs(a.c, SORT_AT)?.usd ?? Infinity) - (theirs(b.c, SORT_AT)?.usd ?? Infinity))
const gaps = VOLUMES.map(v => { const next = nextCheapest(v)!, us = ours(v); return next.q.usd / us.usd })
const times = (n: number) => `${n >= 10 ? Math.floor(n) : Math.floor(n * 10) / 10}×`

export function PriceTable() {
  const [all, setAll] = useState(false)
  return <figure className="lc-figure lc-table" data-all={all || undefined} aria-labelledby="lc-table-title" style={{ '--desk-rows': DESK_ROWS, '--phone-rows': PHONE_ROWS } as CSSProperties}>
    <p id="lc-table-title" className="lc-figure-title">The lowest price in every column, against {PROVIDERS.length} other email APIs.</p>
    <div className="lc-table-wrap">
      <table>
        <colgroup><col className="lc-col-name" />{VOLUMES.map(v => <col key={v} />)}</colgroup>
        <thead><tr><th scope="col"><span className="lc-long">Emails a month</span><span className="lc-short">Emails</span></th>{VOLUMES.map(v => <th key={v} scope="col"><span className="lc-long">{formatCount(v)}</span><span className="lc-short" aria-hidden="true">{short(v)}</span></th>)}</tr></thead>
        <tbody>
          <tr className="lc-us"><th scope="row">Nightmail</th>{VOLUMES.map(v => <td key={v}>{ours(v).text}</td>)}</tr>
          <tr className="lc-gap"><th scope="row" title="How many times Nightmail’s price the cheapest other provider charges"><span className="lc-long">Next cheapest costs</span><span className="lc-short">Next cheapest</span></th>{gaps.map((gap, i) => <td key={VOLUMES[i]}>{times(gap)}</td>)}</tr>
          {rows.map(({ c, quotes }, i) => <tr key={c.slug} data-desk-beyond={i >= DESK_ROWS || undefined} data-phone-beyond={i >= PHONE_ROWS || undefined}>
            <th scope="row"><Link to={c.path}>{c.offer.vendor}</Link></th>
            {quotes.map((q, j) => <td key={VOLUMES[j]} title={q ? `${c.offer.vendor}, ${q.plan}` : `${c.offer.vendor} publishes no price at ${formatCount(VOLUMES[j]!)} emails`}>{q ? q.text : '—'}</td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
    <button type="button" className="lc-more" onClick={() => setAll(true)}>Show all {rows.length}</button>
    <p className="lc-note">{sourceLine()}</p>
  </figure>
}
