// (With extensions: the build's config imports this file, through pages.ts.)
import { productName, publicOrigin } from '../../../../../api/src/brand.ts'
import { fitWords, formatCount, money, nightmail, quote, shownSources, type Source } from '../prices.ts'
import { billAt, ORDERED } from '../page/comparison.ts'
import { briefFactsSection } from '../page/facts.ts'
import { folded, plain, type Doc, type Section, type Table, type Text } from './doc.ts'
import { checkedOn, DASH, month, spelled } from './alternatives.ts'

// /email-for-ai-agents: what a month of email costs for agents, on Nightmail and on every agent-inbox service the
// comparisons price (compare/<slug>.ts, the agents group), in the shape of the other price pages (Ryan: "headline, button,
// comparison underneath"): the headline, scoped by the count of services on its table; Get started; one table, a month at
// three numbers of inboxes, each with the same mail, Nightmail first, the rest by their price at the middle size, each
// linked to its comparison; the facts every price page lists; its pages. What it says of Nightmail is the one claim the data
// shows, which the build checks for every priced cell: it costs less than each service listed, at every size shown.

/** The numbers of inboxes the table prices, as /compare's agent table does (page/hub.ts). */
export const AGENT_SIZES = [10, 50, 100]
/** Services on the table: every agent-inbox service the comparisons price, up to this many (one calm table on a phone). */
export const SHOWN_AGENTS = 9

export function emailForAgents(): Doc {
  const services = ORDERED.filter(c => c.focus === 'agents' && c.model.per === 'inbox')
  const m = services[0]!.model
  if (m.per !== 'inbox' || services.some(c => c.model.per !== 'inbox' || c.model.receivedPerInbox !== m.receivedPerInbox || c.model.sentPerInbox !== m.sentPerInbox))
    throw new Error('/email-for-ai-agents prices every agent-inbox service with the same mail per inbox: their comparisons must agree (compare/<slug>.ts, model).')
  const group = services.map(c => ({ c, bills: AGENT_SIZES.map(size => billAt(c, size)) }))
  const mid = (row: (typeof group)[number]) => row.bills[1]!.theirsCents ?? Infinity
  group.sort((a, b) => mid(a) - mid(b))
  const ours = AGENT_SIZES.map(size => billAt(services[0]!, size))
  // Ryan's rule (A294): Nightmail costs less than each service listed at every size shown; the build stops where it isn't.
  for (const { c, bills } of group) for (const b of bills) if (b.theirsCents !== null && !(b.oursUc < BigInt(b.theirsCents) * 1_000_000n))
    throw new Error(`/email-for-ai-agents would show Nightmail at ${b.ours} and ${c.offer.vendor} at ${b.theirs} for ${b.size} inboxes: pick sizes where Nightmail costs less (docs/agents.ts, AGENT_SIZES).`)
  const shown = group.filter(row => row.bills[1]!.theirsCents !== null).slice(0, SHOWN_AGENTS), left = group.filter(row => !shown.includes(row))
  const lowest = Math.min(...shown.map(mid))
  if (!(ours[1]!.oursUc < BigInt(lowest) * 1_000_000n)) throw new Error('/email-for-ai-agents: the headline\'s "from" price must be above Nightmail\'s.')
  const checked = [...new Set(shown.map(row => row.c.offer.checked))].sort()
  const when = checkedOn(checked)
  const each = `${m.receivedPerInbox} in and ${m.sentPerInbox} out each a month`
  // Nightmail's bill is $0 at every size here when they fit its free allowance: said beside it, as the reason.
  const allFree = ours.every(b => b.oursUc === 0n)
  const freeInboxes = Math.min(Math.floor(nightmail.freeSent / m.sentPerInbox), Math.floor(nightmail.freeReceived / m.receivedPerInbox))

  const middle = ours[1]!
  const h1: Doc['h1'] = [[`${productName} `, { ours: middle.ours, sent: middle.u.sent, received: middle.u.received }, '.'], [`${shown.length} others from ${money(lowest)}.`]]
  const caption = `${capital(spelled(shown.length))} agent-inbox services, ${AGENT_SIZES[1]} inboxes, ${each} · checked ${when.replaceAll(' ', '\u00a0')}`
  const head = ['Agent inboxes', ...AGENT_SIZES.map(formatCount)]
  const nightmailRow = { cells: [[productName], ...ours.map(b => [{ ours: b.ours, sent: b.u.sent, received: b.u.received }])] as Text[] }
  const row = ({ c, bills }: (typeof group)[number]) => ({ cells: [[{ text: c.offer.vendor, href: c.path }], ...bills.map(b => [b.theirs ?? '—'])] as Text[] })
  const dash = (rows: (typeof group)[number][]) => rows.some(r => r.bills.some(b => b.theirsCents === null)) ? DASH : ''
  const claim = `${productName} costs less than each service here at every size shown.`
  const terms = `${productName}: ${nightmail.perThousand} per 1,000 emails, sent or received, after ${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free a month${allFree ? `, so up to ${formatCount(freeInboxes)} inboxes with this mail cost nothing on a domain of your own (the built-in domain sends only to your workspace’s members)` : ''}.`
  const table = (rows: (typeof group)[number][], note: string): Table => ({ kind: 'table', numeric: [1, 2, 3], caption: [note], head, rows: [nightmailRow, ...rows.map(row)] })
  const sections: Section[] = [
    { id: 'agents', title: `Email for AI agents: a month at ${AGENT_SIZES.join(', ')} inboxes`, quiet: true, blocks: [folded(table(shown, `These are the ${group.length} agent-inbox services ${productName} has compared itself with, not every one. ${claim} Each inbox receives ${m.receivedPerInbox} and sends ${m.sentPerInbox} emails a month. ${terms} The others: monthly list prices before tax, each one’s least expensive plan for the size, checked ${when}; each name links to its comparison and the page it was read on.${dash(shown)}`))] },
    // Its price facts, the free allowance first, then that an inbox costs nothing (PANELS.receive) and agents' MCP.
    briefFactsSection([{ shared: 'free' }, 'No charge per inbox', { shared: 'agents' }, { shared: 'teammates' }], []),
  ]
  const read = (rows: (typeof group)[number][]) => rows.flatMap(({ c, bills }) => shownSources(bills.flatMap(b => { const q = quote(c.offer, b.u); return q.kind === 'price' ? [q.tier.source] : [] }), c.offer))
  const cited = read(shown), all: Source[] = [...new Map(read(group).map(source => [source.url, source])).values()]
  const copySections: Section[] = left.length ? [{ id: 'left', title: 'Not on the page’s table', blocks: [{ kind: 'p', text: [`Priced in their comparisons but not on the table: ${left.map(r => r.c.offer.vendor).join(', ')}. Every comparison is on `, { text: 'the comparisons page', href: '/compare' }, '.'] }] }] : []

  const path = '/email-for-ai-agents', latest = checked.at(-1)!
  const searchTitle = fitWords([`Email for AI agents (${month(latest)}): inbox prices side by side`, `Email for AI agents (${month(latest)}): inbox prices`, 'Email for AI agents'], 60)
  const lead = `Email for AI agents, checked ${when}: ${AGENT_SIZES[1]} inboxes, ${each}, Nightmail ${middle.ours}`
  const description = fitWords([
    `${lead}${allFree ? ' within its free allowance' : ''}, and ${shown.length} agent-inbox services from ${money(lowest)}.`,
    `${lead}, ${shown.length} agent-inbox services from ${money(lowest)}, each at three sizes.`,
    `${lead}, and ${shown.length} others from ${money(lowest)}.`,
  ], 160, 140)
  return {
    path, title: 'Email for AI agents', searchTitle, description, h1, answer: [[caption]], caption: [`Per ${AGENT_SIZES[1]} agent inboxes, ${m.receivedPerInbox} in and ${m.sentPerInbox} out each · checked ${when.replaceAll(' ', '\u00a0')}`], sections, questions: [],
    cardWords: { lines: [`${productName} ${middle.ours}.`, `${shown.length} others from ${money(lowest)}.`], caption: fitWords([`${AGENT_SIZES[1]} agent inboxes, ${each}, checked ${when}.`, `${AGENT_SIZES[1]} agent inboxes, checked ${when}.`], 70) },
    sources: [], cited, copy: { sections: copySections, questions: [], sources: all, related: [] },
    related: [
      { title: 'Compare', path: '/compare', line: `${productName} beside every email service it is compared with.` },
      { title: 'Price calculator', path: '/pricing', line: `What ${productName} costs at your own numbers.` },
    ],
    focus: 'agents', modified: latest,
    crumbs: [{ name: productName, path: '/' }, { name: 'Compare', path: '/compare' }, { name: 'Email for AI agents', path }],
    about: { name: productName, url: `${publicOrigin}/` },
    items: [{ name: productName, url: `${publicOrigin}/pricing` }, ...shown.map(r => ({ name: r.c.offer.vendor, url: `${publicOrigin}${r.c.path}` }))],
    llms: `${plain(h1[0])} ${plain(h1[1])} ${caption.replaceAll('\u00a0', ' ')}: ${shown.map(r => `${r.c.offer.vendor} ${r.bills[1]!.theirs}`).join(', ')}.`,
  }
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
