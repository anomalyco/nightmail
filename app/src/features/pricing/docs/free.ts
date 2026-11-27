// (With extensions: the build's config imports this file, through pages.ts.)
import { productName, publicOrigin } from '../../../../../api/src/brand.ts'
import { BUILTIN_CAPS } from '../../../../../api/src/builtin-limits.ts'
import { EVALUATION, GROWTH } from '../../../../../api/src/standing-model.ts'
import { formatCount, listOf, nightmail, shownSources, type Comparison, type Source } from '../prices.ts'
import { ORDERED } from '../page/comparison.ts'
import { briefFactsSection } from '../page/facts.ts'
import { folded, plain, type Doc, type Section, type Table, type Text } from './doc.ts'
import { checkedOn, month as monthOf, spelled } from './alternatives.ts'

// /free-email-api: the search for a free tier (many arrive after SendGrid's became a trial), answered with what the data
// shows. Nightmail's line is its allowance in full, from the billing code; the rows are the compared services whose standing
// free allowance is smaller, or that offer only a trial or a one-off, each in the vendor's own units with its caps and its
// end. Services with a larger free allowance aren't rows, and the scope sentence (first under the table, first in the
// Markdown copy, in the llms.txt line and the description) says what the list is without naming them. The build stops on
// a row whose monthly sending allowance (a daily one times 30 when the vendor states no monthly one) reaches Nightmail's,
// on a figure missing from the vendor's own quoted words, and on a missing scope sentence or count.

/** A compared service's free allowance, read from its entry (compare/<slug>.ts): which of its quoted sources says it
 *  (a free plan's tier, or one of its rows), and the figures in that quote. Every figure must appear in the quote. */
type Free = {
  kind: 'standing' | 'trial' | 'once' | 'larger' | 'unstated' | 'none'
  /** Emails a month (or in the period), a day, received a month, once; contacts or inboxes the plan holds. */
  month?: number; day?: number; received?: number; once?: number; holds?: number
  period?: string
  /** The trial's length, or what else the vendor's words attach (on request, to your own domain). */
  length?: string; terms?: string
  source: (c: Comparison) => Source | undefined
}
const tier = (c: Comparison) => c.offer.plans.flatMap(plan => plan.tiers).find(t => t.cents === 0)?.source
const row = (short: string | RegExp) => (c: Comparison) => c.rows.find(r => typeof short === 'string' ? r.short === short : short.test(r.short ?? ''))?.source
/** Every compared service with a free plan, trial or one-off in its entry, by slug. */
export const FREE: Record<string, Free> = {
  resend: { kind: 'standing', month: 3_000, day: 100, source: tier },
  mailgun: { kind: 'standing', day: 100, source: row('Free every month') },
  mailersend: { kind: 'standing', month: 500, source: tier },
  mailtrap: { kind: 'standing', month: 4_000, day: 150, source: tier },
  smtp2go: { kind: 'standing', month: 1_000, day: 200, source: tier },
  ahasend: { kind: 'standing', month: 1_000, source: row('Free every month') },
  cloudmailin: { kind: 'standing', received: 10_000, source: tier },
  mailpace: { kind: 'standing', month: 100, terms: 'on request', source: row('Free every month') },
  mailchannels: { kind: 'standing', month: 3_000, day: 100, source: row('Free every month') },
  sendgrid: { kind: 'trial', day: 100, length: '60 days', source: row('Free every month') },
  socketlabs: { kind: 'trial', length: 'one month', terms: 'a month of Core or a set amount of credits', source: row('Free every month') },
  mandrill: { kind: 'once', once: 500, terms: 'to your verified domain', source: row('Free every month') },
  postmark: { kind: 'standing', month: 100, source: tier },
  unione: { kind: 'trial', month: 6_000, length: 'four months', terms: 'four months of 6,000 a month, with a card', source: row('Free every month') },
  mailjet: { kind: 'larger', month: 6_000, day: 200, source: tier },
  bird: { kind: 'standing', month: 1_000, source: row('Free every month') },
  mailchimp: { kind: 'standing', month: 500, holds: 250, day: 250, source: tier },
  mailerlite: { kind: 'standing', month: 2_500, holds: 250, source: tier },
  aweber: { kind: 'standing', month: 3_000, holds: 500, source: tier },
  loops: { kind: 'standing', month: 4_000, period: '30 days', holds: 1_000, source: tier },
  ghost: { kind: 'trial', length: '14 days', source: row('Free every month') },
  emailoctopus: { kind: 'larger', month: 10_000, holds: 2_500, source: tier },
  brevo: { kind: 'larger', day: 300, source: tier },
  beehiiv: { kind: 'larger', holds: 2_500, terms: 'unlimited email sends', source: tier },
  buttondown: { kind: 'unstated', holds: 100, source: tier },
  robotomail: { kind: 'standing', month: 10, received: 10, holds: 1, terms: 'only with your verified address', source: tier },
  agentmail: { kind: 'standing', month: 3_000, holds: 3, source: tier },
  nylas: { kind: 'standing', month: 3_000, holds: 3, source: tier },
  postfleet: { kind: 'standing', month: 3_000, day: 100, holds: 3, source: tier },
  lumbox: { kind: 'standing', month: 100, received: 500, holds: 3, source: tier },
  'mails-ai': { kind: 'standing', month: 3_000, holds: 1, source: tier },
  'dead-simple-email': { kind: 'larger', month: 5_000, holds: 5, source: tier },
  'agent-identity': { kind: 'unstated', holds: 5, source: tier },
  inkbox: { kind: 'unstated', holds: 3, source: tier },
}
/** Emails a month a free allowance sends, as the comparison counts it: the monthly figure, else a daily one times 30, else a
 *  one-off. Undefined where the vendor states no sending figure. */
const monthly = (f: Free) => f.month ?? (f.day !== undefined ? f.day * 30 : f.once)
const GROUPS = [
  { focus: 'developer', title: 'Email APIs', unit: 'email APIs' },
  { focus: 'newsletter', title: 'Newsletter services', unit: 'newsletter services' },
  { focus: 'agents', title: 'Agent inboxes', unit: 'agent-inbox services' },
] as const
const unitWord = (c: Comparison, n: number) => c.offer.unit === 'contacts' ? (n === 1 ? 'contact' : 'contacts') : c.offer.unit === 'inboxes' ? (n === 1 ? 'inbox' : 'inboxes') : ''

export function freeEmailApi(): Doc {
  const read = ORDERED.map(c => ({ c, f: FREE[c.slug], source: FREE[c.slug]?.source(c) }))
  const n = ORDERED.length
  // Each figure is the vendor's: it must stand in the quote it was read from, with or without its thousands' commas.
  for (const { c, f, source } of read) {
    if (!f) continue
    if (!source) throw new Error(`/free-email-api reads ${c.offer.vendor}'s free allowance from a source its entry doesn't have (docs/free.ts).`)
    const words = source.quote.replaceAll(',', '').toLowerCase()
    for (const figure of [f.month, f.day, f.received, f.once, f.holds].filter((x): x is number => x !== undefined))
      if (!words.includes(String(figure)) && !(figure % 1000 === 0 && words.includes(`${figure / 1000}k`)))
        throw new Error(`/free-email-api says ${c.offer.vendor} gives ${formatCount(figure)}, which its source doesn't say (${source.url}, read ${source.checked}): docs/free.ts.`)
    if (f.length && !words.includes(f.length.split(' ')[0]!.toLowerCase())) throw new Error(`/free-email-api gives ${c.offer.vendor}'s trial as ${f.length}, which its source doesn't say (docs/free.ts).`)
  }
  // The rows: a standing allowance smaller than Nightmail's, a trial (it ends, whatever its size), or a one-off; the build
  // stops on a standing or one-off row that isn't smaller.
  const listed = read.filter(r => r.f && (r.f.kind === 'standing' || r.f.kind === 'trial' || r.f.kind === 'once'))
  for (const { c, f } of listed.filter(r => r.f!.kind !== 'trial')) {
    const sends = monthly(f!)
    if ((sends !== undefined && sends >= nightmail.freeSent) || (f!.received !== undefined && f!.received >= nightmail.freeReceived))
      throw new Error(`/free-email-api lists ${c.offer.vendor} among the free allowances smaller than Nightmail's, and it isn't (docs/free.ts).`)
  }
  for (const { c, f } of read) if (f && f.kind === 'larger' && !((monthly(f) ?? Infinity) >= nightmail.freeSent || f.terms))
    throw new Error(`/free-email-api leaves out ${c.offer.vendor} as larger, and its allowance isn't (docs/free.ts).`)
  const checked = [...new Set(listed.map(r => r.source!.checked))].sort()
  const when = checkedOn(checked)
  const byGroup = GROUPS.map(g => ({ ...g, all: ORDERED.filter(c => c.focus === g.focus), rows: listed.filter(r => r.c.focus === g.focus) }))
  const apis = byGroup[0]!

  // The cells, in the vendor's own units: what is free, and its caps or its end.
  const cells = (c: Comparison, f: Free): [string, string] => {
    const holds = f.holds !== undefined ? `, ${formatCount(f.holds)} ${unitWord(c, f.holds)}` : ''
    const free = f.kind === 'once' ? `${formatCount(f.once!)}, once` : f.kind === 'trial' ? (f.day !== undefined ? `Trial: ${formatCount(f.day)} a day` : f.terms ? `Trial: ${f.terms}` : 'Trial')
      : [f.month !== undefined ? `${formatCount(f.month)} ${c.offer.unit === 'contacts' ? 'sends' : 'sent'} ${f.period ? `in ${f.period}` : 'a month'}` : f.day !== undefined ? `${formatCount(f.day)} a day` : '',
        f.received !== undefined ? `${formatCount(f.received)} received a month` : ''].filter(Boolean).join(', ') + holds
    const limits = [f.kind === 'trial' && !f.terms ? `Ends after ${f.length}` : '', f.kind !== 'trial' && f.month !== undefined && f.day !== undefined ? `${formatCount(f.day)} a day` : '', f.terms && f.kind !== 'trial' ? capital(f.terms) : ''].filter(Boolean).join('; ')
    return [capital(free.replace(/^, /, '')), limits || '—']
  }
  // Nightmail's row, its $0 marked with the mail it covers (blue, as on every price page, and read back by check-premerge).
  const ours: Text[] = [[productName], [{ ours: '$0', sent: nightmail.freeSent, received: nightmail.freeReceived }, ` for ${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received a month`], ['No end date']]
  const table = (rows: typeof listed, note: Text): Table => ({ kind: 'table', numeric: [], caption: note, head: ['Service', 'Free', 'Limits'], rows: [{ cells: ours }, ...rows.map(({ c, f }) => ({ cells: [[{ text: c.offer.vendor, href: c.path }], ...cells(c, f!).map(t => [t])] as Text[] }))] })

  const scope = `Shown: the ${apis.rows.length} of ${apis.all.length} email APIs ${productName} has compared itself with whose free allowance is smaller than its own, or is a trial or a one-off; this is not every email API.`
  const lead = `Listed: the ${listed.length} of ${n} email services ${productName} has compared itself with whose free allowance is smaller than its own, or is a trial or a one-off (${byGroup.map(g => `${g.rows.length} ${g.unit}`).join(', ')}); this is not every email service.`
  const limits = `On a new workspace the first ${formatCount(EVALUATION.recipients)} recipients are a check: more go out once their results are in, then from ${formatCount(GROWTH.start)} an hour, ${GROWTH.factor === 2 ? 'doubling' : 'growing'} each clean hour, for ${GROWTH.hours} hours; the built-in domain sends only to your workspace’s members, ${formatCount(BUILTIN_CAPS.members.perDay)} a day.`
  const terms = `${productName}: ${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month, with no end date; past it, ${nightmail.perThousand} per 1,000 emails, sent or received.`
  const basis = `The others: each one’s free plan, trial or one-off as its own page states it, checked ${when}; a daily allowance counts as 30 days’ worth where no monthly one is stated, and a dash under Limits means none is stated. Each name links to its comparison and the page it was read on.`
  const note: Text = [`${scope} ${terms} ${limits} ${basis}`]
  const h1: Doc['h1'] = [[`${formatCount(nightmail.freeSent)} emails free.`], ['Every month.']]
  // What the shown rows are, in words true of each: a trial isn't a free plan, and a one-off (Mandrill's demo) is neither.
  const kinds = new Set(apis.rows.map(r => r.f!.kind)), unit = kinds.has('once') ? 'allowances' : 'plans'
  const what = `free ${unit}${kinds.has('trial') && unit === 'plans' ? ' and trials' : ''}`
  const caption = `${productName}, beside ${spelled(apis.rows.length)} email APIs’ ${what} · checked ${when.replaceAll(' ', '\u00a0')}`
  const sections: Section[] = [
    // Under the table, only How we compared, which holds the scope sentence and the rest.
    { id: 'free', title: 'Free email API plans', quiet: true, blocks: [folded(table(apis.rows, note))] },
    // (Its headline and first row are the free allowance: the list says the rest.)
    briefFactsSection([], [], { free: false }),
  ]
  const copySections: Section[] = byGroup.slice(1).filter(g => g.rows.length).map(g => ({ id: g.focus, title: g.title, blocks: [table(g.rows, [`The ${g.rows.length} of ${g.all.length} ${g.unit} ${productName} has compared itself with whose free allowance is smaller than its own, or is a trial; this is not every one.`])] }))
  const all: Source[] = [...new Map(listed.map(r => shownSources([r.source!], r.c.offer)[0]!).map(s => [s.url, s])).values()]
  const cited = shownSources(apis.rows.map(r => r.source!), apis.rows[0]!.c.offer).map((s, i) => shownSources([apis.rows[i]!.source!], apis.rows[i]!.c.offer)[0] ?? s)

  const latest = checked.at(-1)!, path = '/free-email-api'
  const searchTitle = `Free email API? ${apis.rows.length} ${what} side by side (${monthOf(latest)})`
  const smaller = `smaller ${unit}${kinds.has('trial') ? ' or trials' : ''}`, free = `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free a month`
  const description = [
    `Free email API plans, checked ${when}: ${productName}, ${free}, beside the ${apis.rows.length} of ${apis.all.length} compared APIs with ${smaller}.`,
    `Free email API plans, checked ${when}: ${productName}, ${free}, beside the ${apis.rows.length} of ${apis.all.length} compared with ${smaller}.`,
    `Free email APIs, checked ${when}: ${productName}, ${free}, beside the ${apis.rows.length} of ${apis.all.length} compared with ${smaller}.`,
  ].find(text => text.length <= 160 && text.length >= 140) ?? ''
  const doc: Doc = {
    path, title: 'Free email API plans', searchTitle, description, h1, answer: [[caption]], caption: [`${apis.rows.length} ${listOf(['smaller free plans', ...kinds.has('trial') ? ['trials'] : [], ...kinds.has('once') ? ['one-offs'] : []])} · checked ${when.replaceAll(' ', '\u00a0')}`], sections, questions: [],
    cardWords: { lines: [`${formatCount(nightmail.freeSent)} emails free.`, 'Every month.'], caption: [`${productName}, beside ${spelled(apis.rows.length)} email APIs’ ${what}, checked ${when}.`, `Beside ${apis.rows.length} email APIs’ ${what}, checked ${when}.`].find(t => t.length <= 70)! },
    sources: [], cited, copy: { sections: copySections, questions: [], sources: all, related: [] }, lead,
    related: [
      { title: 'Compare', path: '/compare', line: `${productName} beside every email service it is compared with.` },
      { title: 'Price calculator', path: '/pricing', line: `What ${productName} costs at your own numbers.` },
    ],
    focus: 'developer', modified: latest,
    crumbs: [{ name: productName, path: '/' }, { name: 'Compare', path: '/compare' }, { name: 'Free email API plans', path }],
    about: { name: productName, url: `${publicOrigin}/` },
    items: [{ name: productName, url: `${publicOrigin}/pricing` }, ...apis.rows.map(r => ({ name: r.c.offer.vendor, url: `${publicOrigin}${r.c.path}` }))],
    llms: `${plain(h1[0])} ${plain(h1[1])} ${caption.replaceAll('\u00a0', ' ')}. ${lead}`,
  }
  const missing = [
    !JSON.stringify(doc.sections).includes(scope) && 'the page', !doc.lead?.includes(`${listed.length} of ${n}`) && 'the Markdown copy', !doc.llms.includes(lead) && 'its llms.txt line',
    !doc.description.includes(`${apis.rows.length} of ${apis.all.length}`) && 'the description', !doc.description && 'a description of 140 to 160 characters',
  ].filter(Boolean)
  if (missing.length) throw new Error(`/free-email-api leaves out what its list is in ${missing.join(', ')} (docs/free.ts).`)
  return doc
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
