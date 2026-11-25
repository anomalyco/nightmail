import { ArrowUpRight } from 'lucide-react'
import { comparisons } from './compare'
import { dayOf, nightmail, type Offer, type Source, type Usage } from './prices'

// The price pages' shared pieces (board.tsx, calculator.tsx): where a figure was read, Nightmail's figures marked with
// the usage they price (data-nightmail-sent and -received, which api/scripts/check-premerge.ts reads back), the
// calculator's sizes and address, and Nightmail's pricing terms.

/** The calculator's numbers, as its address names them. */
export type Field = 'sent' | 'received' | 'contacts' | 'teammates'
export const sizeOf = (u: Usage): Record<Field, number> => ({ sent: u.sent, received: u.received, contacts: u.contacts, teammates: u.seats })
/** Small, medium and large: the sizes of the Mailchimp comparison, so the calculator opens on figures that were checked. */
export const PRESETS = (['Small', 'Medium', 'Large'] as const).map((name, i) => ({ name, size: sizeOf(comparisons.mailchimp!.sizes[i]!) }))
/** A calculator address for a usage: /pricing?sent=…&received=…&contacts=…&teammates=… */
export const calculatorPath = (u: Usage) => `/pricing?${new URLSearchParams(Object.entries(sizeOf(u)).map(([k, v]) => [k, String(v)]))}`

const host = (url: string) => new URL(url).hostname.replace(/^www\./, '')
/** Where and when a figure was read: the date, and a link to the vendor's page. */
export function Checked({ source: { checked, url } }: { source: Pick<Source, 'checked' | 'url'> }) {
  return <span className="price-checked">Checked {dayOf(checked)} on <a href={url} target="_blank" rel="noopener noreferrer">{host(url)}<ArrowUpRight size={12} aria-hidden="true" /></a></span>
}
/** The days the vendors' pricing pages were read, and links to them: "Checked 22 Nov 2026 on a.com and b.com". */
export function CheckedPages({ offers }: { offers: readonly Pick<Offer, 'pricing' | 'checked'>[] }) {
  const pages = [...new Map(offers.map(offer => [offer.pricing, offer.checked])).entries()]
  const days = [...new Set(pages.map(([, checked]) => checked))].sort()
  const join = (i: number, n: number) => i === 0 ? '' : i === n - 1 ? ' and ' : ', '
  return <>{days.map((day, d) => {
    const urls = pages.filter(([, checked]) => checked === day).map(([url]) => url)
    return <span key={day}>{join(d, days.length)}{d === 0 && 'Checked '}{dayOf(day)} on {urls.map((url, i) => <span key={url}>{join(i, urls.length)}<a href={url} target="_blank" rel="noopener noreferrer">{host(url)}</a></span>)}</span>
  })}</>
}
/** A claim's source, after it: a link to the page it was read on (the list's note says when). */
export function Cite({ source: { checked, url } }: { source: Source }) {
  const label = `${host(url)}, checked ${dayOf(checked)}`
  return <a className="price-cite" href={url} target="_blank" rel="noopener noreferrer" title={label} aria-label={`Source: ${label}`}><ArrowUpRight size={14} aria-hidden="true" /></a>
}
/** Every page a comparison's figures were read on, each a link, and the days: "Pages read on 24 Nov 2026: a, b and c." */
export function ReadOn({ sources }: { sources: Source[] }) {
  const pages = [...new Map(sources.map(source => [source.url, source])).values()], days = [...new Set(sources.map(source => source.checked))].sort().map(dayOf)
  const page = (url: string) => { const u = new URL(url); return host(url) + u.pathname.replace(/\/$/, '') }
  return <>Pages read on {days.join(', ')}: {pages.map((source, i) => <span key={source.url}>{i > 0 && (i === pages.length - 1 ? ' and ' : ', ')}<a href={source.url} target="_blank" rel="noopener noreferrer">{page(source.url)}</a></span>)}.</>
}
/** A Nightmail figure, marked with the usage it prices. */
export function Ours({ sent, received, children }: { sent: number; received: number; children: string }) {
  return <span data-nightmail-sent={sent} data-nightmail-received={received}>{children}</span>
}

/** Nightmail's pricing terms, in each page's small print: what a buyer is told before paying. */
export function Terms({ floor }: { floor: string | null }) {
  return <ul className="price-terms">
    <li>Paid from prepaid credit. Top-ups start at {nightmail.minTopUp} and expire {nightmail.expiresAfterMonths} months after purchase.{floor && ` At this size that’s at least ${floor} a year.`}</li>
    <li>Received mail kept past {nightmail.storageAfterDays} days: {nightmail.storagePerGb} per GB a month after {nightmail.freeStorageGb} GB free.</li>
  </ul>
}
