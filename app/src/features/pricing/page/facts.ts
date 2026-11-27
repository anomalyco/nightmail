// (With extensions: the build's config imports this file, through comparison.ts and hub.ts.)
import { formatCount, nightmail, type Line, type Row, type SharedFact } from '../prices.ts'
import { PANELS } from '../panels.ts'
import type { Section } from './shape.ts'

// "Nightmail does this, this and this": the short list of facts under a price page's table (page.tsx draws it as a
// list), each one line in plain words. The facts true on every page are written here once, from the billing code
// (prices.ts, nightmail) and the product's own list (panels.ts), and every page that lists facts reuses them: the
// comparisons (comparison.ts, after their own), /compare (hub.ts), and any page made in the same shape (shape.ts).
// A comparison's own facts are its rows (compare/<slug>.ts): each row's line, or its first sentence; a row whose point
// is one of the shared facts names it, so the page says it once. The free allowance is on every list; eight lines at most.

/** The facts every page can say, each with the subject that makes it a repeat of a page's own line. */
export const SHARED_FACTS: Record<SharedFact, { text: string; covers?: RegExp; brief: string }> = {
  free: { text: `${formatCount(nightmail.freeSent)} emails sent and ${formatCount(nightmail.freeReceived)} received free every month`, brief: `Free monthly: ${formatCount(nightmail.freeSent)} sent, ${formatCount(nightmail.freeReceived)} received` },
  domains: { text: 'Sends and receives on your own domains', covers: /\bown (?:sending )?domains?\b/i, brief: 'Send and receive on your domains' },
  contacts: { text: 'No charge for contacts, however many you have', covers: /\bcontacts?\b/i, brief: 'No charge for contacts' },
  teammates: { text: 'No charge for teammates', covers: /\bteammates?\b/i, brief: 'No charge for teammates' },
  agents: { text: PANELS.agent.line.replace(/\.$/, ''), covers: /\bMCP\b|\bagents?\b/i, brief: 'Agents answer email over MCP' },
  campaigns: { text: 'Newsletters cost the same as any other email', covers: /\bnewsletters?\b/i, brief: 'Newsletters cost the same per email' },
}
export const MAX_FACTS = 8

/** A comparison's rows as its own lines: each row's line, or its first sentence. */
export const rowLines = (rows: Row[]): Line[] => rows.flatMap(row => row.line ?? row.text.split(/(?<=\.) /)[0]!)

/** A page's list of facts: its own lines (shared ones in their place), then the shared ones it doesn't already say. */
export function factsFor(own: Line[]): string[] {
  const said = new Set<SharedFact>(), mine: string[] = []
  for (const line of own) {
    if (typeof line !== 'string' && 'shared' in line) said.add(line.shared)
    const text = typeof line === 'string' ? line.trim().replace(/\.$/, '') : 'shared' in line ? SHARED_FACTS[line.shared].text : line.text
    if (!mine.includes(text)) mine.push(text)
  }
  const rest = (Object.keys(SHARED_FACTS) as SharedFact[]).filter(id => !said.has(id) && !mine.some(text => SHARED_FACTS[id].covers?.test(text)))
  const list = [...mine, ...rest.map(id => SHARED_FACTS[id].text)].slice(0, MAX_FACTS)
  if (!list.includes(SHARED_FACTS.free.text)) throw new Error(`A facts list leaves out the free allowance: ${JSON.stringify(own)}`)
  return list
}
/** The facts as a page's section: a list under a small label. */
export const factsSection = (own: Line[] = []): Section => ({ id: 'facts', title: 'With Nightmail', blocks: [{ kind: 'list', items: factsFor(own).map(text => [text]) }] })

/** The short list the vendor and ranking pages show (docs/): at most four facts of at most six words, what a price-shopper
 *  weighs first: the page's own short lines, then the free allowance, contacts, teammates, newsletters. A longer own line
 *  stays in the page's Markdown copy and its comparison. */
export const BRIEF = { facts: 4, words: 6 }
export const wordCount = (text: string) => text.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length
export function briefFacts(own: Line[] = [], { free = true } = {}): string[] {
  const said = new Set<SharedFact>(), list: string[] = []
  for (const line of own) {
    if (typeof line !== 'string' && 'shared' in line) said.add(line.shared)
    const text = typeof line === 'string' ? line.trim().replace(/\.$/, '') : 'shared' in line ? SHARED_FACTS[line.shared].brief : line.brief
    if (wordCount(text) <= BRIEF.words && !list.includes(text)) list.push(text)
  }
  for (const id of ['free', 'contacts', 'teammates', 'campaigns', 'domains', 'agents'] as SharedFact[]) if ((free || id !== 'free') && !said.has(id) && !list.some(text => SHARED_FACTS[id].covers?.test(text))) list.push(SHARED_FACTS[id].brief)
  const brief = !free || list.includes(SHARED_FACTS.free.brief) ? list : [SHARED_FACTS.free.brief, ...list]
  return brief.slice(0, BRIEF.facts)
}
/** The short list on the page, the whole list (factsFor: the page's own lines, or fullOwn) in its Markdown twin. free:
 *  false on a page whose headline is the free allowance (/free-email-api), so the list doesn't repeat it. */
export const briefFactsSection = (own: Line[] = [], fullOwn: Line[] = own, options: { free?: boolean } = {}): Section => ({ id: 'facts', title: 'With Nightmail', blocks: [{ kind: 'list', items: briefFacts(own, options).map(text => [text]), full: factsFor(fullOwn).map(text => [text]) }] })
