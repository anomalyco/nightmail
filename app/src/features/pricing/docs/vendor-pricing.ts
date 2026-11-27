// (With extensions: the build's config imports this file, through pages.ts.)
import { productName } from '../../../../../api/src/brand.ts'
import { dayOf, fitWords, formatCount, lastChecked, listOf, money, nightmail, quote, shownSources, sourceNote, sourcesOf, ucOf, type Comparison, type Plan, type Source, type Tier } from '../prices.ts'
import { billAt, middle, perSize, priceTable, verdictHeading, verdictOf } from '../page/comparison.ts'
import { briefFactsSection, rowLines } from '../page/facts.ts'
import { comparisonQuestions } from '../questions.ts'
import { ALTERNATIVES_VENDORS } from './registry.ts'
import { folded, plain, type Doc, type Question, type Section, type Text } from './doc.ts'

// A vendor's pricing page (/pricing/<slug>, "SendGrid pricing"): the verdict, Get started, and one table, what the vendor
// costs at each size its own page prices beside Nightmail, with one note under it (Ryan: "headline, button, comparison
// underneath"). Its plans, its free plan or trial, how each charges and the questions are in the Markdown copy only
// (doc.copy), which assistants read. All of it is made from its comparison's entry alone (compare/<slug>.ts): every plan, tier, rate, limit and free
// allowance it read, each with the vendor's page and the day, and Nightmail beside it. Nothing is typed: a figure is the
// entry's or the billing code's, and every sentence about the vendor names where it was read. What the page says of
// Nightmail against the vendor is one claim, scoped to the sizes in its table, which the build checks row by row
// (vendorPricing throws where it wouldn't hold). The words differ from vendor to vendor because the data does: its plans,
// its sizes, its rates, its limits, its free plan or trial, and where a smaller plan plus its overage costs less than the
// next one up.

type Priced = { plan: Plan; tier: Tier }
const host = (page: string) => new URL(page).hostname.replace(/^www\./, '')
const link = (source: Pick<Source, 'url'>, text = host(source.url)) => ({ text, href: source.url })
/** "Nov 2026", for a title. */
const month = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Where the page's table was read, in its note: each page once, with the day. */
function readAt(sources: Source[]): Text {
  const pages = [...new Map(sources.map(source => [source.url, source])).values()], days = [...new Set(pages.map(source => source.checked))]
  const join = (i: number) => i === 0 ? '' : i === pages.length - 1 ? ' and ' : ', '
  return days.length === 1 ? [`Read ${dayOf(days[0]!)} on `, ...pages.flatMap((source, i) => [join(i), link(source, label(source.url))]), '.']
    : ['Read on ', ...pages.flatMap((source, i) => [join(i), link(source, label(source.url)), ` (${dayOf(source.checked)})`]), '.']
}
// (A page is named by its host and the last part of its path: "twilio.com/…/twi121--sendgrid-pricing-pdf-st1.pdf".)
const label = (url: string) => { const parts = new URL(url).pathname.split('/').filter(Boolean); return host(url) + (parts.length > 1 ? `/…/${parts.at(-1)}` : parts.length ? `/${parts[0]}` : '') }

/** Where a table's figures were read: each page and day once, with what was read there. */
function readOn(read: { source: Source; what: string }[]): Text {
  const pages = new Map<string, { source: Source; what: Set<string> }>()
  for (const { source, what } of read) {
    const key = `${source.url} ${source.checked}`, page = pages.get(key) ?? { source, what: new Set<string>() }
    page.what.add(what)
    pages.set(key, page)
  }
  const list = [...pages.values()], days = [...new Set(list.map(page => page.source.checked))]
  return [days.length === 1 ? `Read ${dayOf(days[0]!)}: ` : 'Read ', ...list.flatMap(({ source, what }, i) => [
    i === 0 ? '' : i === list.length - 1 ? '; and ' : '; ', `${listOf([...what])} on `, link(source, label(source.url)), sourceNote(source.url), days.length === 1 ? '' : `, ${dayOf(source.checked)}`,
  ]), '.']
}

export function vendorPricing(c: Comparison, pricingPages: { slug: string; vendor: string }[]): Doc {
  const { offer, model: m } = c, vendor = offer.vendor, day = dayOf(offer.checked), contacts = offer.unit === 'contacts'
  const all: Priced[] = offer.plans.flatMap(plan => plan.tiers.map(tier => ({ plan, tier })))
  // Priced by contacts, a plan sells each contact count once; a plan that repeats one across its tiers (Brevo: 500,000
  // contacts from 20,000 to 500,000 emails) prices by emails, and its contacts are a limit.
  const byEmails = contacts && offer.plans.some(plan => plan.tiers.some((tier, i) => i > 0 && tier.size === plan.tiers[i - 1]!.size))
  const paid = all.filter(p => p.tier.cents > 0), free = all.filter(p => p.tier.cents === 0)
  // A size in the vendor's own unit, and a usage as the page prices it: the assumption first, so no figure needs working out.
  const count = (n: number) => `${formatCount(n)} ${offer.unit}`, size = (n: number) => offer.unit === 'emails' ? `${count(n)} a month` : count(n)

  // ---------------------------------------------------------------- the facts the page is made of

  const start = [...paid].sort((a, b) => a.tier.cents - b.tier.cents || a.tier.size - b.tier.size)[0]!
  const largest = Math.max(...paid.map(p => p.tier.size)), top = paid.filter(p => p.tier.size === largest).sort((a, b) => a.tier.cents - b.tier.cents)[0]!
  const rates = paid.filter(p => p.tier.overage !== undefined).map(p => p.tier.overage!)
  const rateRange = rates.length ? (Math.min(...rates) === Math.max(...rates) ? money(rates[0]!) : `${money(Math.min(...rates))} to ${money(Math.max(...rates))}`) : null
  const seated = offer.plans.filter(plan => plan.seats)
  // Teammates as the vendor's page names them ("additional teammates": besides the account's owner).
  const seatWord = seated.find(plan => plan.seats!.label)?.seats!.label ?? 'teammates'
  // Free: a plan sold at $0, and what the entry quotes the vendor saying about free use (a trial, a daily limit).
  const freeDetails = (p: Priced) => [contacts ? `up to ${size(p.tier.size)}` : size(p.tier.size), ...p.tier.sends !== undefined && contacts ? [`${formatCount(p.tier.sends)} emails a month`] : [], ...p.plan.note ? [p.plan.note] : []]
  const freePlans = free.map(p => ({ text: `${vendor}’s ${p.plan.name} plan costs $0 for ${freeDetails(p).join(', ')}.`, source: p.tier.source }))
  const freeSaid = c.rows.flatMap(row => row.source && row.short === 'Free every month' ? [{ text: row.note ?? row.text, source: row.source }] : [])
    // (Said once: a quote that repeats a free plan's own limit, Brevo's "300 emails a day", is left out.)
    .filter(fact => !free.some(p => p.plan.note && fact.text.includes(p.plan.note)))
  const freeFacts = [...freePlans, ...freeSaid]

  // Each size the vendor prices (the comparison's steps: the pre-merge check proves the vendor prices each one), with both
  // bills as the comparison's table shows them (page/comparison.ts, billAt) and how the vendor's is bought.
  const rows = c.steps.map(n => {
    const b = billAt(c, n), q = quote(offer, b.u)
    if (q.kind !== 'price' || b.theirsCents === null) throw new Error(`${c.slug}: ${vendor}’s page prices no plan at ${size(n)}, a step of its comparison (compare/${c.slug}.ts).`)
    // Ryan's rule (A294): the page says Nightmail costs less at every size in this table, so it must, at each one.
    if (!(b.oursUc < ucOf(b.theirsCents))) throw new Error(`/pricing/${c.slug} would say Nightmail costs less than ${vendor} at ${size(n)}, and it doesn't (${b.ours} against ${b.theirs}): take the size out of the comparison's steps (compare/${c.slug}.ts).`)
    return { n, b, q }
  })
  const open = rows.find(row => row.n === middle(c)) ?? rows[Math.floor(rows.length / 2)]!
  // The verdict's size: the vendor's smallest paid plan, bought without overage or extras, where Nightmail's bill isn't $0
  // (a $0 would need its reason beside it); else the size the comparison opens at.
  const verdictAt = rows.find(row => row.n === start.tier.size && row.b.oursUc > 0n && !(row.q.kind === 'price' && (row.q.payg || row.q.extra))) ?? open

  // ---------------------------------------------------------------- the answer, first

  const freeLine = freeFacts.map(fact => fact.text).join(' ')
  // The verdict as a comparison's (page/comparison.ts): both bills, the vendor's without its plan (the table's marked row
  // names it), and the size with the day read; the same in a card's few words.
  const v = verdictOf(c, verdictAt.n), h1 = verdictHeading(c, v) as Doc['h1'], caption = v.at
  const cardWords: Doc['cardWords'] = { lines: [`${productName} ${v.ours}.`, `${vendor} ${v.theirs}.`], caption: `${perSize(c, verdictAt.n)}, checked ${day}.` }

  // ---------------------------------------------------------------- the sections

  // Two tables, each with its note under it in a line or two: what its figures assume, and where and when they were read.
  const capped = offer.plans.filter(plan => plan.max)
  // A ladder sold by the unit (Mandrill: each number of blocks a plan of its own, at its band's rate) reads as its bands:
  // one-tier plans in a row, read from the same quote at the same price per email, are one row from the first to the last.
  const seatsOf = (plan: Plan) => plan.seats ? plan.seats.count === null ? 'Unlimited' : formatCount(plan.seats.count) : '—'
  const bands: { first: Priced; last: Priced }[] = []
  for (const p of all) {
    const band = bands.at(-1), low = band?.first.tier, high = band?.last.tier
    const alike = band && low && high && p.plan.tiers.length === 1 && band.last.plan.tiers.length === 1 && p.tier.overage === undefined && high.overage === undefined
      && p.tier.sends === undefined && high.sends === undefined && !p.plan.seats && !band.last.plan.seats
      && p.tier.source.url === low.source.url && p.tier.source.quote === low.source.quote && p.tier.cents * low.size === low.cents * p.tier.size
    if (alike) band.last = p; else bands.push({ first: p, last: p })
  }
  // "1 block" to "20 blocks": "1 to 20 blocks".
  const spanName = (from: string, to: string) => { const a = /^([\d,]+) /.exec(from), b = /^([\d,]+) (.+)$/.exec(to); return a && b ? `${a[1]} to ${b[1]} ${b[2]}` : `${from} to ${to}` }
  const plansTable: Section = {
    id: 'plans', title: offer.ladder === 'complete' ? `Every ${vendor} plan` : `Every ${vendor} price read`,
    blocks: [{ kind: 'table',
      caption: [`List prices, billed monthly, no promotions${offer.ladder === 'complete' ? '' : ' (the sizes read here; its page prices more)'}.${capped.length ? ` ${listOf(capped.map(plan => `${plan.name} goes up to ${formatCount(plan.max!.size)}`))} ${offer.unit}.` : ''}${offer.beyond ? ` Above ${formatCount(largest)}: ${offer.beyond.text}.` : ''} `, ...readOn([
        ...all.map(p => ({ source: p.tier.source, what: p.tier.cents === 0 ? 'the free plan' : 'prices' })),
        ...all.flatMap(p => p.tier.overageSource ? [{ source: p.tier.overageSource, what: 'the rate past a plan' }] : []),
        ...seated.map(plan => ({ source: plan.seats!.source, what: seatWord })),
        ...capped.map(plan => ({ source: plan.max!.source, what: 'the largest size' })),
        ...offer.beyond ? [{ source: offer.beyond.source, what: 'custom pricing' }] : [],
      ])],
      head: ['Plan', ...byEmails ? ['Emails a month', 'Contact limit'] : contacts ? ['Contacts', 'Emails a month'] : ['Emails a month'], 'Price a month', ...rates.length ? ['Each 1,000 past it'] : [], ...seated.length ? [capital(seatWord)] : []],
      numeric: [1, 2, 3, 4, 5].slice(0, (contacts ? 3 : 2) + (rates.length ? 1 : 0) + (seated.length ? 1 : 0)),
      rows: bands.map(({ first, last }) => {
        const span = (n: (tier: Tier) => string) => first === last ? n(first.tier) : `${n(first.tier)} to ${n(last.tier)}`
        const sends = [span(tier => tier.sends === undefined ? '—' : formatCount(tier.sends))], held = [span(tier => formatCount(tier.size))]
        return { cells: [
          [first === last ? first.plan.name : spanName(first.plan.name, last.plan.name)], ...byEmails ? [sends, held] : contacts ? [held, sends] : [held], [span(tier => money(tier.cents))],
          ...rates.length ? [[first.tier.overage === undefined ? '—' : money(first.tier.overage)]] : [],
          ...seated.length ? [[seatsOf(first.plan)]] : [],
        ] }
      }) }],
  }
  // Where the sizes' figures were read: the plans' prices, the rate past a plan where a size uses it, and the teammates
  // where the size assumes some; a data file as the pricing page it belongs to (prices.ts, shownSources).
  const tableRead = shownSources(rows.flatMap(({ q }) => q.kind !== 'price' ? [] : [
    q.tier.source, ...q.payg?.tier.overageSource ? [q.payg.tier.overageSource] : [], ...m.per === 'contact' && m.seats > 1 && q.plan.seats ? [q.plan.seats.source] : [],
  ]), offer)
  const sizesTable: Section = {
    id: 'sizes', title: `What ${vendor} costs at each size`, quiet: true,
    blocks: [
      folded(priceTable(c, [`${c.assume} Monthly billing, no promotions. ${productName}: ${nightmail.perThousand} per 1,000 emails, sent or received, after ${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free a month. ${productName} costs less than ${vendor} at every size in this table. `, ...readAt(tableRead)], verdictAt.n)),
    ],
  }
  // Then what Nightmail has that the vendor charges for or lacks, and the facts every price page says (page/facts.ts).
  const sections: Section[] = [sizesTable, briefFactsSection(rowLines(c.rows))]

  // ---------------------------------------------------------------- the questions, from the same facts

  // For the Markdown copy: what it costs and whether it's free, from the plans; the rest as its comparison's page asks them
  // (questions.ts), word for word: whether Nightmail costs less at its large size, how each charges, what Nightmail has
  // that it charges for or lacks, and what it has that Nightmail doesn't. (Its middle size is a row of the table.)
  const where = `${host(offer.pricing)}, ${day}`, asked = comparisonQuestions(c), ask = (id: string) => asked.filter(item => item.id === id)
  const questions: Question[] = [
    { id: 'cost', question: `How much does ${vendor} cost?`, answer: `From ${money(start.tier.cents)} a month for ${count(start.tier.size)} (${start.plan.name}) to ${money(top.tier.cents)} for ${count(largest)} (${top.plan.name})${offer.beyond && offer.ladder === 'complete' ? `; above that, ${offer.beyond.text}` : ', the largest size read here'}. List prices before tax (${where}).` },
    ...freeFacts.length ? [{ id: 'free', question: `Is ${vendor} free?`, answer: `${freeLine} Its paid plans start at ${money(start.tier.cents)} a month (${start.plan.name}). (${listOf([...new Set(freeFacts.map(fact => host(fact.source.url)))])}, ${dayOf(freeFacts.map(fact => fact.source.checked).sort().at(-1)!)}.)` }] : [],
    ...ask('less'), ...ask('charges'), ...ask('has'), ...ask('lacks'),
  ]

  // ---------------------------------------------------------------- its title, description and links

  const path = `/pricing/${c.slug}`, when = month(offer.checked)
  const searchTitle = fitWords([
    ...rates.length ? [`${vendor} pricing (${when}): plans, overage and monthly cost`] : [],
    `${vendor} pricing (${when}): every plan and its monthly cost`, `${vendor} pricing (${when}): plans and monthly cost`, `${vendor} pricing (${when})`,
  ], 60)
  const from = `from ${money(start.tier.cents)} a month for ${count(start.tier.size)}`
  const perThousand = [...new Set(paid.map(p => Math.round(p.tier.cents * 1000 / p.tier.size)))]
  const freeShort = free.length ? `${free[0]!.plan.name} plan: $0 for ${count(free[0]!.tier.size)}` : freeSaid.length ? freeSaid[0]!.text.replace(/\.$/, '') : null
  const oursShort = verdictAt === open ? `${productName} ${open.b.ours} at ${count(open.n)}, ${vendor} ${open.b.theirs}` : `${productName}: ${verdictAt.b.ours} for the same ${count(verdictAt.n)}`
  const description = fitWords([
    ...freeShort ? [`${vendor} pricing, read ${day}: ${from}. ${freeShort}. ${oursShort}.`] : [],
    ...rateRange ? [`${vendor} pricing, read ${day}: ${from}, ${rateRange} per 1,000 past it. ${oursShort}.`] : [],
    // (A ladder priced by volume with no overage, Mandrill's blocks: what 1,000 emails cost from its dearest size to its cheapest.)
    ...offer.unit === 'emails' && perThousand.length > 1 ? [`${vendor} pricing, read ${day}: ${from}, ${money(Math.min(...perThousand))} to ${money(Math.max(...perThousand))} per 1,000 by volume. ${oursShort}.`] : [],
    `${vendor} pricing, read ${day}: every plan, ${from}. ${oursShort}.`,
    `${vendor} pricing, read ${day}: every plan and its price, ${from}, and what a month costs at each size.`,
  ], 160, 140)
  // On the page, the vendor's own other pages and the calculator; the other vendors' pricing pages in the copy's More.
  const related = [
    { title: c.title, path: c.path, line: `${vendor} and ${productName} at every size ${vendor} prices, side by side.` },
    ...ALTERNATIVES_VENDORS.includes(c.slug) ? [{ title: `${vendor} alternatives`, path: `/alternatives/${c.slug}`, line: `${productName} and the services nearest ${vendor} in price, at three sizes.` }] : [],
    { title: 'Price calculator', path: '/pricing', line: `What ${productName} costs at your own numbers.` },
  ]
  const others = pricingPages.filter(other => other.slug !== c.slug).map(other => ({ title: `${other.vendor} pricing`, path: `/pricing/${other.slug}`, line: `What ${other.vendor} costs, plan by plan.` }))
  const doc: Doc = {
    path, title: `${vendor} pricing`, searchTitle, description, h1, answer: [[caption]], cardWords, sections, questions: [],
    // (The note under the table names its sources and the day, so the page's end doesn't list them again.)
    sources: [], cited: tableRead, copy: { sections: [plansTable], questions, sources: sourcesOf(c), related: others },
    related, focus: c.focus, modified: lastChecked(c),
    crumbs: [{ name: productName, path: '/' }, { name: 'Pricing', path: '/pricing' }, { name: vendor, path }],
    about: { name: vendor, url: offer.pricing },
    llms: `${plain(h1[0])} ${plain(h1[1])} ${caption.replaceAll('\u00a0', ' ')}. ${questions[0]!.answer}`,
  }
  return doc
}
