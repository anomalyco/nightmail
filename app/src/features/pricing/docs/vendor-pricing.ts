// (With extensions: the build's config imports this file, through pages.ts.)
import { productName } from '../../../../../api/src/brand.ts'
import { usd } from '../../../../../api/src/billing/rates.ts'
import { dayOf, fitWords, formatCount, lastChecked, listOf, money, nightmail, nightmailBill, quote, sourcesOf, ucOf, type Comparison, type Plan, type Source, type Tier, type Usage } from '../prices.ts'
import { plain, type Doc, type Question, type Section, type Text } from './doc.ts'

// A vendor's pricing page (/pricing/<slug>, "SendGrid pricing"): what the vendor costs, plan by plan and at each size its
// own page prices, made from its comparison's entry alone (compare/<slug>.ts): every plan, tier, rate, limit and free
// allowance it read, each with the vendor's page and the day, and Nightmail beside it. Nothing is typed: a figure is the
// entry's or the billing code's, and every sentence about the vendor names where it was read. What the page says of
// Nightmail against the vendor is one claim, scoped to the sizes in its table, which the build checks row by row
// (vendorPricing throws where it wouldn't hold). The words differ from vendor to vendor because the data does: its plans,
// its sizes, its rates, its limits, its free plan or trial, and where a smaller plan plus its overage costs less than the
// next one up.

type Priced = { plan: Plan; tier: Tier }
const host = (page: string) => new URL(page).hostname.replace(/^www\./, '')
const link = (source: Pick<Source, 'url'>, text = host(source.url)) => ({ text, href: source.url })
/** A fact's words, then where it was read: "… (twilio.com, read 25 Nov 2026)." */
const cite = (text: string, source: Source): Text => [text.replace(/\.$/, ''), ' (', link(source), `, read ${dayOf(source.checked)}).`]
/** "Nov 2026", for a title. */
const month = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Where a table's figures were read: each page once, with what was read there and the day. */
function readOn(read: { source: Source; what: string }[]): Text {
  const pages = new Map<string, { source: Source; what: Set<string> }>()
  for (const { source, what } of read) {
    const page = pages.get(source.url) ?? { source, what: new Set<string>() }
    if (source.checked > page.source.checked) page.source = source
    page.what.add(what)
    pages.set(source.url, page)
  }
  const list = [...pages.values()], days = [...new Set(list.map(page => page.source.checked))]
  // (A page is named by its host and the last part of its path: "twilio.com/…/twi121--sendgrid-pricing-pdf-st1.pdf".)
  const label = (url: string) => { const parts = new URL(url).pathname.split('/').filter(Boolean); return host(url) + (parts.length > 1 ? `/…/${parts.at(-1)}` : parts.length ? `/${parts[0]}` : '') }
  return [days.length === 1 ? `Read ${dayOf(days[0]!)}: ` : 'Read ', ...list.flatMap(({ source, what }, i) => [
    i === 0 ? '' : i === list.length - 1 ? '; and ' : '; ', `${listOf([...what])} on `, link(source, label(source.url)), days.length === 1 ? '' : `, ${dayOf(source.checked)}`,
  ]), '.']
}

export function vendorPricing(c: Comparison, pricingPages: { slug: string; vendor: string }[]): Doc {
  const { offer, model: m } = c, vendor = offer.vendor, day = dayOf(offer.checked), contacts = offer.unit === 'contacts'
  const all: Priced[] = offer.plans.flatMap(plan => plan.tiers.map(tier => ({ plan, tier })))
  const paid = all.filter(p => p.tier.cents > 0), free = all.filter(p => p.tier.cents === 0)
  // A size in the vendor's own unit, and a usage as the page prices it: the assumption first, so no figure needs working out.
  const count = (n: number) => `${formatCount(n)} ${offer.unit}`, size = (n: number) => offer.unit === 'emails' ? `${count(n)} a month` : count(n)
  const usage = (u: Usage) => m.per === 'contact' ? `${formatCount(u.contacts)} contacts sent ${m.sendsPerContact} emails each (${formatCount(u.sent)} emails a month)${m.seats > 1 ? `, with ${m.seats} teammates` : ''}`
    : m.per === 'inbox' ? `${formatCount(u.inboxes ?? 0)} inboxes, each receiving ${m.receivedPerInbox} and sending ${m.sentPerInbox} emails a month`
      : m.per === 'received' ? `${formatCount(u.received)} emails received a month` : `${formatCount(u.sent)} emails a month`
  const listed = [link({ url: offer.pricing }), ` on ${day}`]

  // ---------------------------------------------------------------- the facts the page is made of

  const start = [...paid].sort((a, b) => a.tier.cents - b.tier.cents || a.tier.size - b.tier.size)[0]!
  const largest = Math.max(...paid.map(p => p.tier.size)), top = paid.filter(p => p.tier.size === largest).sort((a, b) => a.tier.cents - b.tier.cents)[0]!
  const rates = paid.filter(p => p.tier.overage !== undefined).map(p => p.tier.overage!)
  const rateRange = rates.length ? (Math.min(...rates) === Math.max(...rates) ? money(rates[0]!) : `${money(Math.min(...rates))} to ${money(Math.max(...rates))}`) : null
  const seated = offer.plans.filter(plan => plan.seats)
  // Free: a plan sold at $0, and what the entry quotes the vendor saying about free use (a trial, a daily limit).
  const freeDetails = (p: Priced) => [contacts ? `up to ${size(p.tier.size)}` : size(p.tier.size), ...p.tier.sends !== undefined && contacts ? [`${formatCount(p.tier.sends)} emails a month`] : [], ...p.plan.note ? [p.plan.note] : []]
  const freePlans = free.map(p => ({ text: `${vendor}’s ${p.plan.name} plan costs $0 for ${freeDetails(p).join(', ')}.`, source: p.tier.source }))
  const freeSaid = c.rows.flatMap(row => row.source && row.short === 'Free every month' ? [{ text: row.note ?? row.text, source: row.source }] : [])
  const freeFacts = [...freePlans, ...freeSaid]
  // Per plan, the emails each contact may be sent a month, where every tier the entry read allows the same multiple.
  const perContact = contacts ? offer.plans.flatMap(plan => {
    const k = plan.tiers.map(t => t.sends === undefined ? NaN : t.sends / t.size)
    return k.every(x => Number.isInteger(x) && x === k[0]) ? [{ plan, k: k[0]! }] : []
  }) : []

  // Each size the vendor prices (the comparison's steps: the pre-merge check proves the vendor prices each one), as a buyer
  // would pay it, with how: a plan, or a smaller plan plus its overage where that costs less.
  const rows = c.steps.map(n => {
    const u = c.use(n), q = quote(offer, u), ours = nightmailBill(u.sent, u.received)
    if (q.kind !== 'price') throw new Error(`${c.slug}: ${vendor}’s page prices no plan at ${size(n)}, a step of its comparison (compare/${c.slug}.ts).`)
    const cents = q.payg?.cents ?? q.cents
    // Ryan's rule (A294): the page says Nightmail costs less at every size in this table, so it must, at each one.
    if (!(ours.uc < ucOf(cents))) throw new Error(`/pricing/${c.slug} would say Nightmail costs less than ${vendor} at ${size(n)}, and it doesn't (${ours.text} against ${money(cents)}): take the size out of the comparison's steps (compare/${c.slug}.ts).`)
    const how = q.payg ? `${q.payg.plan.name} (${formatCount(q.payg.tier.size)} included) + ${formatCount(n - q.payg.tier.size)} more at ${money(q.payg.tier.overage!)} per 1,000`
      : q.extra ? `${q.plan.name} + ${formatCount(q.extra)} ${q.tier.extra!.name}`
        : q.tier.size !== (contacts ? u.contacts : n) ? `${q.plan.name} (${formatCount(q.tier.size)} included)` : q.plan.name
    return { n, u, q, cents, ours, how }
  })
  const open = rows.find(row => row.n === (contacts ? c.sizes[1]!.contacts : offer.unit === 'inboxes' ? c.sizes[1]!.inboxes : c.sizes[1]!.sent)) ?? rows[Math.floor(rows.length / 2)]!
  const first = rows[0]!, last = rows.at(-1)!
  // The verdict's size: the vendor's smallest paid plan, where Nightmail's bill isn't $0 (a $0 would need its reason
  // beside it); else the size the comparison opens at.
  const verdictAt = rows.find(row => row.n === start.tier.size && row.ours.uc > 0n && !(row.q.kind === 'price' && (row.q.payg || row.q.extra))) ?? open

  // ---------------------------------------------------------------- the answer, first

  const startLine = `${vendor}’s paid plans start at ${money(start.tier.cents)} a month for ${count(start.tier.size)} (${start.plan.name}${contacts && start.tier.sends ? `, ${formatCount(start.tier.sends)} emails a month` : ''}).`
  const topLine = offer.beyond && offer.ladder === 'complete'
    ? `The largest plan its page prices, ${top.plan.name} at ${count(largest)}, is ${money(top.tier.cents)} a month; above that: ${offer.beyond.text}.`
    : `The largest size read here, ${size(largest)}, costs ${money(top.tier.cents)} a month on ${top.plan.name}.`
  const freeLine = freeFacts.map(fact => fact.text).join(' ')
  const rateLine = rateRange ? `Past a paid plan’s emails, each 1,000 more costs ${rateRange}, by plan.` : ''
  const verdict: Doc['verdict'] = {
    lines: [[`${vendor} ${verdictAt.how}: ${money(verdictAt.cents)} a month.`], [`${productName}: `, { ours: verdictAt.ours.text, sent: verdictAt.u.sent, received: verdictAt.u.received }, ` for the same ${count(verdictAt.n)}.`]],
    caption: `${m.per === 'contact' ? `Each contact sent ${m.sendsPerContact} emails a month (${formatCount(verdictAt.u.sent)} emails)${m.seats > 1 ? `, ${m.seats} teammates` : ''}.` : m.per === 'email' ? 'One recipient each.' : `${usage(verdictAt.u)}.`} List prices before tax, checked ${day}.`,
  }
  const answer: Text[] = [
    [`${startLine} ${topLine} List prices before tax, billed monthly, read on `, ...listed, '.'],
    ...freeLine || rateLine ? [[[freeLine, rateLine].filter(Boolean).join(' ')]] : [],
    [`${productName} costs less than ${vendor} at each of the ${rows.length} sizes priced below, from ${formatCount(first.n)} to ${size(last.n)}: ${nightmail.perThousand} per 1,000 emails, sent or received, after ${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free a month.`],
  ]

  // ---------------------------------------------------------------- the sections

  const plansTable: Section = {
    id: 'plans', title: offer.ladder === 'complete' ? `Every ${vendor} plan` : `Every ${vendor} price read`,
    blocks: [
      { kind: 'table',
        caption: [`List prices before tax, billed monthly, without promotions, as ${vendor}’s page lists them${offer.ladder === 'complete' ? '' : ' (the sizes read here; its page prices more)'}. `, ...readOn([
          ...all.map(p => ({ source: p.tier.source, what: p.tier.cents === 0 ? 'the free plan' : 'prices' })),
          ...all.flatMap(p => p.tier.overageSource ? [{ source: p.tier.overageSource, what: 'the rate past a plan’s emails' }] : []),
          ...seated.map(plan => ({ source: plan.seats!.source, what: 'teammates' })),
          ...offer.plans.flatMap(plan => plan.max ? [{ source: plan.max.source, what: 'the largest size' }] : []),
        ])],
        head: ['Plan', contacts ? 'Contacts' : 'Emails a month', ...contacts ? ['Emails a month'] : [], 'Price a month', ...rates.length ? ['Each 1,000 past it'] : [], ...seated.length ? ['Teammates'] : []],
        numeric: [1, 2, 3, 4, 5].slice(0, (contacts ? 3 : 2) + (rates.length ? 1 : 0) + (seated.length ? 1 : 0)),
        rows: all.map(p => ({ cells: [
          [p.plan.name], [formatCount(p.tier.size)], ...contacts ? [[p.tier.sends === undefined ? '—' : formatCount(p.tier.sends)]] : [], [money(p.tier.cents)],
          ...rates.length ? [[p.tier.overage === undefined ? '—' : money(p.tier.overage)]] : [],
          ...seated.length ? [[p.plan.seats ? p.plan.seats.count === null ? 'Unlimited' : formatCount(p.plan.seats.count) : '—']] : [],
        ] })) },
      ...offer.beyond ? [{ kind: 'p' as const, text: cite(`Above ${size(largest)}: ${offer.beyond.text}`, offer.beyond.source) }] : [],
    ],
  }
  const limits: Text[] = [
    ...seated.length ? [cite(`Teammates: ${listOf(seated.map(plan => `${plan.name} ${plan.seats!.count === null ? 'unlimited' : formatCount(plan.seats!.count)}`))}`, seated[0]!.seats!.source)] : [],
    ...offer.plans.flatMap(plan => plan.max ? [cite(`${plan.name}: up to ${size(plan.max.size)}`, plan.max.source)] : []),
    ...perContact.length ? [[`Emails a month per contact, from the plans above: ${listOf(perContact.map(({ plan, k }) => `${plan.name} ${k}`))}.`]] : [],
    ...offer.plans.flatMap(plan => plan.note && !free.some(p => p.plan === plan) ? [[`${plan.name}: ${plan.note}.`]] : []),
  ]
  const sizesTable: Section = {
    id: 'sizes', title: `What ${vendor} costs at each size`,
    blocks: [
      { kind: 'table',
        caption: [`${c.assume} Monthly billing, no promotions. ${vendor}’s prices read on `, ...listed, `.${contacts ? '' : ' Per 1,000: the month’s price over its emails, to the cent.'}`],
        head: [contacts ? 'Contacts' : 'Emails a month', ...contacts ? ['Emails a month'] : [], `${vendor}: how it’s bought`, `${vendor} a month`, ...contacts ? [] : [`${vendor} per 1,000`], `${productName} a month`],
        numeric: contacts ? [0, 1, 3, 4] : [0, 2, 3, 4],
        rows: rows.map(row => ({ mark: row === open, cells: [
          [formatCount(row.n)], ...contacts ? [[formatCount(row.u.sent)]] : [], [row.how], [money(row.cents)],
          ...contacts ? [] : [[usd(ucOf(row.cents) * 1000n / BigInt(row.u.sent + row.u.received))]],
          [{ ours: row.ours.text, sent: row.u.sent, received: row.u.received }],
        ] })) },
      { kind: 'p', text: [`${productName} costs less than ${vendor} at every size in this table.`] },
    ],
  }
  const beside: Section = {
    id: 'beside', title: `${vendor} beside ${productName}`,
    blocks: [
      { kind: 'p', text: [`${c.lead} ${productName}: ${nightmail.perThousand} per 1,000 emails, sent or received, after ${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free a month; contacts and teammates free; paid from prepaid credit (top-ups from ${nightmail.minTopUp}, valid ${nightmail.expiresAfterMonths} months).`] },
      { kind: 'p', text: [`What ${productName} has that ${vendor} charges for or lacks:`] },
      { kind: 'list', items: c.rows.map(row => row.source ? cite(row.text, row.source) : [row.text]) },
      ...c.without?.length ? [{ kind: 'p' as const, text: [`Not in ${productName}: ${listOf(c.without)}.`] }] : [],
    ],
  }
  const sections: Section[] = [
    plansTable,
    ...limits.length ? [{ id: 'limits', title: 'What each plan allows', blocks: [{ kind: 'list' as const, items: limits }] }] : [],
    sizesTable,
    ...freeFacts.length ? [{ id: 'free', title: `Is ${vendor} free?`, blocks: [{ kind: 'list' as const, items: freeFacts.map(fact => cite(fact.text, fact.source)) }] }] : [],
    beside,
  ]

  // ---------------------------------------------------------------- the questions, from the same facts

  const where = `${host(offer.pricing)}, ${day}`
  const questions: Question[] = [
    { id: 'cost', question: `How much does ${vendor} cost?`, answer: `From ${money(start.tier.cents)} a month for ${count(start.tier.size)} (${start.plan.name}) to ${money(top.tier.cents)} for ${count(largest)} (${top.plan.name})${offer.beyond && offer.ladder === 'complete' ? `; above that, ${offer.beyond.text}` : ', the largest size read here'}. List prices before tax (${where}).` },
    { id: 'size', question: `How much does ${vendor} cost for ${size(open.n)}?`,
      answer: `For ${usage(open.u)}: ${money(open.cents)} a month on ${open.how}, the least ${vendor} lists for that, before tax (${where}).` },
    ...freeFacts.length ? [{ id: 'free', question: `Is ${vendor} free?`, answer: `${freeLine} Its paid plans start at ${money(start.tier.cents)} a month (${start.plan.name}). (${listOf([...new Set(freeFacts.map(fact => host(fact.source.url)))])}, ${dayOf(freeFacts.map(fact => fact.source.checked).sort().at(-1)!)}.)` }] : [],
    ...rateRange ? [{ id: 'overage', question: `What does ${vendor} charge past a plan’s emails?`,
      answer: `${capital(rateRange)} per 1,000 emails past a plan’s own, by plan; the table of plans has each (${where}).` }] : [],
    { id: 'less', question: `Does ${productName} cost less than ${vendor}?`,
      answer: `At every size this page prices, yes: from ${first.ours.text} against ${money(first.cents)} at ${size(first.n)} to ${last.ours.text} against ${money(last.cents)} at ${size(last.n)} (${vendor}’s prices read ${day}). ${productName} charges ${nightmail.perThousand} per 1,000 emails, sent or received, after ${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free every month.` },
  ]

  // ---------------------------------------------------------------- its title, description and links

  const path = `/pricing/${c.slug}`, when = month(offer.checked)
  const searchTitle = fitWords([
    ...rates.length ? [`${vendor} pricing (${when}): plans, overage and monthly cost`] : [],
    `${vendor} pricing (${when}): every plan and its monthly cost`, `${vendor} pricing (${when}): plans and monthly cost`, `${vendor} pricing (${when})`,
  ], 60)
  const from = `from ${money(start.tier.cents)} a month for ${count(start.tier.size)}`
  const freeShort = free.length ? `${free[0]!.plan.name} plan: $0 for ${count(free[0]!.tier.size)}` : freeSaid.length ? freeSaid[0]!.text.replace(/\.$/, '') : null
  const oursShort = verdictAt === open ? `${productName} ${open.ours.text} at ${count(open.n)}, ${vendor} ${money(open.cents)}` : `${productName}: ${verdictAt.ours.text} for the same ${count(verdictAt.n)}`
  const description = fitWords([
    ...freeShort ? [`${vendor} pricing, read ${day}: ${from}. ${freeShort}. ${oursShort}.`] : [],
    ...rateRange ? [`${vendor} pricing, read ${day}: ${from}, ${rateRange} per 1,000 past it. ${oursShort}.`] : [],
    `${vendor} pricing, read ${day}: every plan, ${from}. ${oursShort}.`,
    `${vendor} pricing, read ${day}: every plan and its price, ${from}, and what a month costs at each size.`,
  ], 160, 140)
  const related = [
    { title: c.title, path: c.path, line: `${vendor} and ${productName} at every size ${vendor} prices, side by side.` },
    ...pricingPages.filter(other => other.slug !== c.slug).map(other => ({ title: `${other.vendor} pricing`, path: `/pricing/${other.slug}`, line: `What ${other.vendor} costs, plan by plan.` })),
    { title: `${productName} price calculator`, path: '/pricing', line: `What ${productName} costs at your own numbers.` },
  ]
  const doc: Doc = {
    path, title: `${vendor} pricing`, searchTitle, description, h1: `${vendor} pricing`, verdict, answer, sections, questions,
    sources: sourcesOf(c), related, focus: c.focus, modified: lastChecked(c),
    crumbs: [{ name: productName, path: '/' }, { name: 'Pricing', path: '/pricing' }, { name: `${vendor} pricing`, path }],
    about: { name: vendor, url: offer.pricing },
    llms: `${plain(verdict.lines[0])} ${plain(verdict.lines[1])} ${verdict.caption} ${plain(answer[0]!)}`,
  }
  return doc
}
