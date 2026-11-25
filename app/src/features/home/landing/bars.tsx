import { useMemo, useState, type CSSProperties } from 'react'
import { Link } from 'react-router'
import { formatCount, nextCheapest, ours, PROVIDERS, ranked, short, sourceLine } from './data'

// Option A: one bar a provider for a month at the volume picked, cheapest first, Nightmail's in the chart's colour.
// Every row stays in the DOM in one order and is moved to its rank, so a new volume slides the bars to their places
// instead of redrawing them; the list's height never changes (a provider with no price there sits at the foot). On a
// phone the cheapest PHONE_ROWS show, so Get started is on the first screen, and "Show all" opens the rest in place.
const VOLUMES = [10_000, 50_000, 100_000, 500_000, 1_000_000]
const KEYS = ['nightmail', ...PROVIDERS.map(c => c.slug)]
const PHONE_ROWS = 8

export function Bars() {
  const [emails, setEmails] = useState(100_000)
  const [all, setAll] = useState(false)
  const rows = useMemo(() => ranked(emails), [emails])
  const max = Math.max(...rows.map(row => row.quote?.usd ?? 0))
  const rank = new Map(rows.map((row, i) => [row.key, i]))
  const next = nextCheapest(emails), us = ours(emails)
  const hidden = rows.slice(PHONE_ROWS), top = hidden.filter(row => row.quote).at(-1)
  return <figure className="lc-figure lc-bars" data-all={all || undefined} aria-labelledby="lc-bars-title">
    <div className="lc-bars-head">
      <p id="lc-bars-title" className="lc-figure-title" aria-live="polite">At {formatCount(emails)} emails a month, Nightmail costs <b>{us.text}</b>.{next && <> The next cheapest, {next.c.offer.vendor}, costs {next.q.text}.</>}</p>
      <div className="lc-volumes" role="radiogroup" aria-label="Emails a month">
        {VOLUMES.map(volume => <button key={volume} type="button" role="radio" aria-checked={volume === emails} aria-label={`${formatCount(volume)} emails a month`} onClick={() => setEmails(volume)}>{short(volume)}</button>)}
      </div>
    </div>
    <ol className="lc-bars-list" style={{ '--rows': KEYS.length, '--phone-rows': PHONE_ROWS } as CSSProperties} aria-label={`A month at ${formatCount(emails)} emails, cheapest first`}>
      {KEYS.map(key => {
        const row = rows.find(r => r.key === key)!, i = rank.get(key)!
        const share = row.quote ? Math.max(row.quote.usd / max, .004) : 0
        return <li key={key} data-us={key === 'nightmail' || undefined} data-none={!row.quote || undefined} data-beyond={i >= PHONE_ROWS || undefined} style={{ '--i': i, '--share': share } as CSSProperties}
          title={row.quote?.plan ? `${row.name}: ${row.quote.text} (${row.quote.plan})` : undefined} aria-posinset={i + 1} aria-setsize={KEYS.length}>
          <span className="lc-bar-name">{row.href ? <Link to={row.href}>{row.name}</Link> : row.name}</span>
          <span className="lc-bar-track">
            <span className="lc-bar-fill" aria-hidden="true" />
            <span className="lc-bar-value">{row.quote ? row.quote.text : 'No price at this volume'}</span>
          </span>
        </li>
      })}
    </ol>
    <button type="button" className="lc-more" onClick={() => setAll(true)}>{hidden.length} more{top?.quote ? `, up to ${top.quote.text}` : ''}. Show all</button>
    <p className="lc-note">{sourceLine()}</p>
  </figure>
}
