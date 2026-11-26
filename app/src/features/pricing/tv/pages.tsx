import type { CSSProperties, ReactNode } from 'react'
import { NightmailWordmark } from '../../../components/NightmailLogo'
import scene from '../../home/tv/crt/scene.webp'
import knob from '../../home/tv/crt/knob.webp'
import still from '../../home/tv/crt/still.json'
import { PRICE_LINKS } from '../live'
import { FIRST_STEP, PANELS } from '../panels'
import { billMath, dayOf, formatCount, listOf, nightmail, nightmailBill, sourcesOf, theirPrice, UNITS, type Comparison, type Source } from '../prices'
import { around, bankOf, billAt, chLabel, channelOf, CHANNELS, checkedDay, claim, groupOf, GROUPS, GUIDE, middle, neighbours, perWords, sizeOf, sizeWords, type Bill, type Channel } from './channels'

// Four ways a comparison page (/compare/<slug>) could work with the homepage's television (features/home/tv), built as
// prototypes on Nightmail vs Resend, plus the guide the fourth one hangs from (/compare). Each is the page's own HTML,
// written at build time (app/compare-tv.ts), with no app code: the words arrive with the page, the set is its photograph
// and CSS, and only the third loads a script (dial.js), for its dial. Every figure is the price pages' arithmetic
// (channels.ts, prices.ts). Nothing here may need a browser: it is rendered in Node.
//
// The set is drawn as the homepage's first screen draws it (app/home-tv.ts): the photograph (scene.webp) with the glass
// open, the table's reflections as still.json has them, and the room lit at its level. Its geometry repeats tv.tsx's,
// which keeps it to itself: SCENE, SET, the keys' and knobs' places and at().
const SCENE = { width: 2048, height: 1152 }, SET = { x: 524, y: 150, width: 1000, height: 736 }
const sceneStyle: CSSProperties = { left: `${-SET.x / SET.width * 100}%`, top: `${-SET.y / SET.height * 100}%`, width: `${SCENE.width / SET.width * 100}%`, height: `${SCENE.height / SET.height * 100}%` }
const BUTTON_X = .9206, BUTTON_Y = [.1044, .1446, .1837, .2239, .2620, .3012, .3404, .3805]
const KNOB_Y = [.4568, .5311]
const HIT = { w: .040, h: .039 }, CAP = { w: .0262, h: .0295 }, DIAL = .05
const at = (x: number, y: number, w: number, h: number) => ({ left: `${(x - w / 2) * 100}%`, top: `${(y - h / 2) * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` })
const capStyle = (x: number, y: number): CSSProperties => {
  const w = CAP.w * SET.width, h = CAP.h * SET.height, left = SET.x + x * SET.width - w / 2, top = SET.y + y * SET.height - h / 2
  return {
    left: `${(1 - CAP.w / HIT.w) * 50}%`, top: `${(1 - CAP.h / HIT.h) * 50}%`, width: `${CAP.w / HIT.w * 100}%`, height: `${CAP.h / HIT.h * 100}%`,
    backgroundImage: `url(${scene})`, backgroundSize: `${SCENE.width / w * 100}% ${SCENE.height / h * 100}%`,
    backgroundPosition: `${left / (SCENE.width - w) * 100}% ${top / (SCENE.height - h) * 100}%`,
  }
}

/** A prototype's address: /compare/resend-tv<n> (served as compare/resend-tv<n>.html, as every comparison's file is). */
export const prototypePath = (slug: string, n: 1 | 2 | 3 | 4) => `/compare/${slug}-tv${n}`
/** Where a channel links from the prototypes: Resend's own prototype of the same direction, the live page for the rest. */
const pathOf = (c: Comparison, n?: 1 | 2 | 3 | 4) => n && c.slug === 'resend' ? prototypePath(c.slug, n) : c.path
const upper = (text: string) => text.toUpperCase()
const ours = (b: Bill) => b.ours, theirs = (b: Bill) => b.theirs ?? '—'

// ---------------------------------------------------------------- the set

/** The way in: the homepage's airmail label (tv.css, .chyp), here a link to Overview with the comparison's focus, which signs
 *  a visitor in there (data/landing-focus.ts). On the table on a wide screen; under it on a phone. */
const Label = ({ c, under, alone }: { c: Comparison; under?: boolean; alone?: boolean }) =>
  <div className={`chyp${under ? ' chyp-under' : ''}${alone ? ' ctv-label' : ''}`}><a className="chyp-go" href={`/overview?focus=${c.focus}`}><span className="srt-cta-label">Get started</span></a></div>
const Consent = () => <p className="chy-consent ctv-consent">By continuing you agree to the <a href="/legal/terms">Terms of Service</a> and <a href="/legal/privacy">Privacy Policy</a>.</p>

type Keys = { channel: Channel; to?: 1 | 2 | 3 | 4 } | null
/** The television on its table, its glass showing `screen`. keys: its eight channel keys tune to this channel's bank of
 *  eight comparisons (channels.ts), this one's key held down; without, the photograph's own keys. dial: a control in the
 *  top knob's place. */
function Television({ c, screen, keys, dial }: { c: Comparison; screen: ReactNode; keys?: Keys; dial?: ReactNode }) {
  return <div className="chy-set" style={{ '--tint': still.tint, '--light': still.light } as CSSProperties}>
    <div className="chy-screen ctv-glass">{screen}</div>
    <span className="chy-glow" />
    <img className="chy-scene" src={scene} alt="" width={SCENE.width} height={SCENE.height} draggable={false} style={sceneStyle} fetchPriority="high" />
    <img className="chy-reflect chy-reflect-shade" src={still.reflect.shade} alt="" />
    <img className="chy-reflect chy-reflect-tint" src={still.reflect.tint} alt="" />
    <a href="/" aria-label="nightmail home" className="chy-badge"><NightmailWordmark /></a>
    {keys && bankOf(keys.channel.n).map((other, i) => other
      ? <a key={i} className="chy-key" href={pathOf(other.comparison, keys.to)} style={at(BUTTON_X, BUTTON_Y[i]!, HIT.w, HIT.h)} aria-label={`${chLabel(other.n)}: Nightmail vs ${other.comparison.offer.vendor}`} aria-current={other === keys.channel ? 'page' : undefined}>
        <span className="chy-well" style={capStyle(BUTTON_X, BUTTON_Y[i]!)} /><span className="chy-cap" style={capStyle(BUTTON_X, BUTTON_Y[i]!)} />
      </a>
      : null)}
    {dial}
    <Label c={c} />
  </div>
}
/** The set's column: the set, then under the table the label (a phone's), the consent and `children`. */
function Stage({ c, screen, keys, dial, children }: { c: Comparison; screen: ReactNode; keys?: Keys; dial?: ReactNode; children?: ReactNode }) {
  return <div className="chy ctv-stage">
    <div className="chy-col">
      <Television c={c} screen={screen} keys={keys} dial={dial} />
      <div className="chy-under ctv-under">
        <div className="chy-way"><Label c={c} under /></div>
        <Consent />
        {children}
      </div>
    </div>
  </div>
}

// ---------------------------------------------------------------- what is on the glass
// The set's own type (tv.tsx draws it on a canvas, a character to a cell, in a VCR's caps): here as text, in the theme's
// own plain version of it (tv.css, .chy-flat: OpenTUI Mono, bold), on the tube's dark with its scanlines.

/** Two bills side by side, as the channel is tuned. */
function PairScreen({ c, bill, channel }: { c: Comparison; bill: Bill; channel: Channel }) {
  return <div className="ctv-tube" data-kind="pair">
    <p className="ctv-top"><span>PLAY</span><span className="ctv-osd">{chLabel(channel.n)}</span></p>
    <p className="ctv-line">{perWords(c, bill.size)}</p>
    <div className="ctv-pair">
      <p data-ours=""><span>NIGHTMAIL</span><b>{ours(bill)}</b></p>
      <p><span>{upper(c.offer.vendor)}</span><b>{theirs(bill)}</b></p>
    </div>
    <p className="ctv-line ctv-soft">{upper(`${c.offer.vendor} ${bill.plan ?? ''}`.trim())}, LIST PRICE</p>
  </div>
}

/** The bills at the dial's size, and the volume it is turned to (the set's green, as it shows a channel). */
function DialScreen({ c, bill, at: i }: { c: Comparison; bill: Bill; at: number }) {
  const cells = 16, lit = (k: number) => k < Math.round(1 + (cells - 1) * i / (c.steps.length - 1))
  return <div className="ctv-tube" data-kind="dial" aria-live="polite">
    <p className="ctv-line" data-dial-size="">{perWords(c, bill.size)}</p>
    <ul className="ctv-rows">
      <li data-ours=""><span>NIGHTMAIL</span><span data-dial-ours="">{ours(bill)}</span></li>
      <li><span>{upper(c.offer.vendor)}</span><span data-dial-theirs="">{theirs(bill)}</span></li>
    </ul>
    <p className="ctv-line ctv-soft" data-dial-plan="">{upper(`${c.offer.vendor} ${bill.plan ?? ''}`.trim())}</p>
    <p className="ctv-volume ctv-osd" aria-hidden="true"><span>VOLUME</span><span className="ctv-cells" data-dial-cells="">{Array.from({ length: cells }, (_, k) => <i key={k} data-on={lit(k) ? '' : undefined} />)}</span></p>
  </div>
}

/** The guide's first page: the ranked channel, as the homepage's tape lists a month. */
function GuideScreen() {
  const section = GUIDE[0]!, rows = section.rows.slice(0, 5)
  return <div className="ctv-tube" data-kind="list">
    <p className="ctv-top"><span>TV GUIDE</span><span className="ctv-osd">CH 01-{String(GUIDE.flatMap(s => s.rows).length).padStart(2, '0')}</span></p>
    <p className="ctv-line">{formatCount(section.columns[1]!)} EMAILS A MONTH</p>
    <ul className="ctv-rows">
      <li data-ours=""><span>NIGHTMAIL</span><span>{section.ours[1]}</span></li>
      {rows.map(row => <li key={row.channel.n}><span>{upper(row.channel.comparison.offer.vendor)}</span><span>{theirs(row.bills[1]!)}</span></li>)}
    </ul>
  </div>
}

// ---------------------------------------------------------------- the comparison in words

const host = (url: string) => new URL(url).hostname.replace(/^www\./, '')
const Cite = ({ source }: { source: Source }) => <> (<a href={source.url} target="_blank" rel="noopener noreferrer">{host(source.url)}</a>, checked {dayOf(source.checked)})</>
/** Questions the page answers, each from the data alone (the SEO plan's: what the vendor costs at a size, what Nightmail
 *  does, whether that holds at every size compared, how each charges). The page shows them and its structured data lists
 *  them (app/compare-tv.ts, FAQPage). */
export function questions(c: Comparison) {
  const vendor = c.offer.vendor, size = middle(c), b = billAt(c, size), u = c.use(size), bill = nightmailBill(u.sent, u.received)
  const first = billAt(c, c.steps[0]!), last = billAt(c, c.steps.at(-1)!)
  const math = [bill.sent, bill.received].filter(line => line.used > 0).map(line => billMath(line)).join('; ')
  return [
    { question: `What does ${vendor} cost at ${sizeWords(c, size)}?`, answer: `${theirs(b)} a month${b.plan ? ` (${b.plan})` : ''}, at list price before tax, as read on ${host(c.offer.pricing)} on ${checkedDay(c)}. Nightmail costs ${b.ours} for the same month.` },
    { question: `What does Nightmail cost at ${sizeWords(c, size)}?`, answer: `${bill.text} a month: ${math}.` },
    { question: `Does Nightmail cost less than ${vendor} at every size?`, answer: `At each size this page compares, from ${sizeWords(c, first.size)} to ${formatCount(last.size)}, yes: from ${first.ours} against ${theirs(first)} to ${last.ours} against ${theirs(last)}. The table above has every size.` },
    { question: `How does ${vendor} charge, and how does Nightmail?`, answer: c.lead },
  ]
}
function sizeHead(c: Comparison) { return c.offer.unit === 'contacts' ? 'Contacts' : c.offer.unit === 'inboxes' ? 'Inboxes' : c.model.per === 'received' ? 'Received a month' : 'Emails a month' }

/** Everything the page says, under its top: the month at every size the vendor prices (its steps), what Nightmail has
 *  that it charges for or lacks, what else is in the box, the terms and the sources. The same for the four directions. */
function Words({ c, lead = true, to }: { c: Comparison; lead?: boolean; to?: 1 | 2 | 3 | 4 }) {
  const vendor = c.offer.vendor, pages = [...new Map(sourcesOf(c).map(source => [source.url, source])).values()]
  return <section className="ctv-words" aria-label={`Nightmail vs ${vendor}, in full`}>
    {lead && <p className="ctv-lead">{c.lead}</p>}
    <h2>A month at each size</h2>
    <table className="ctv-table">
      <caption>{c.assume} Monthly billing, no promotions. {vendor}’s prices checked {checkedDay(c)} on <a href={c.offer.pricing} target="_blank" rel="noopener noreferrer">{host(c.offer.pricing)}</a>.</caption>
      <thead><tr><th scope="col">{sizeHead(c)}</th><th scope="col">Nightmail</th><th scope="col">{vendor}</th><th scope="col" className="ctv-plan">{vendor} plan</th></tr></thead>
      <tbody>{c.steps.map(size => { const b = billAt(c, size); return <tr key={size} data-opening={size === middle(c) ? '' : undefined}>
        <th scope="row">{formatCount(size)}</th><td data-ours="">{b.ours}</td><td>{theirs(b)}<span className="ctv-plan-under">{b.plan}</span></td><td className="ctv-plan">{b.plan}</td>
      </tr> })}</tbody>
    </table>
    <p className="ctv-note">Nightmail charges {nightmail.perThousand} per 1,000 emails after {formatCount(nightmail.freeSent)} sent and {formatCount(nightmail.freeReceived)} received free a month.</p>
    <h2>What Nightmail has that {vendor} charges for or lacks</h2>
    <ul className="ctv-list">{c.rows.map(row => <li key={row.text}>{row.text}{row.source && <Cite source={row.source} />}</li>)}</ul>
    <h2>Also in the box</h2>
    <ul className="ctv-list ctv-box">{c.panels.map(id => <li key={id}><b>{PANELS[id].title}</b> {PANELS[id].line}</li>)}</ul>
    {c.without?.length ? <p>Not in the box: {listOf(c.without)}.</p> : null}
    <p>{FIRST_STEP[c.focus]}</p>
    {c.faq?.length ? <><h2>Questions</h2>{c.faq.map(item => <div key={item.question}><h3>{item.question}</h3><p>{item.answer}</p></div>)}</> : null}
    <h2>Questions</h2>
    {questions(c).map(item => <div key={item.question} className="ctv-qa"><h3>{item.question}</h3><p>{item.answer}</p></div>)}
    <h2>Nightmail’s pricing terms</h2>
    <ul className="ctv-list">
      <li>{nightmail.perThousand} per 1,000 emails, sent or received, after {formatCount(nightmail.freeSent)} sent and {formatCount(nightmail.freeReceived)} received free every month. Contacts and teammates: no charge.</li>
      <li>Paid from prepaid credit. Top-ups start at {nightmail.minTopUp} and expire {nightmail.expiresAfterMonths} months after purchase.</li>
      <li>Received mail kept past {nightmail.storageAfterDays} days: {nightmail.storagePerGb} per GB a month after {nightmail.freeStorageGb} GB free.</li>
    </ul>
    <h2>Sources</h2>
    <p className="ctv-note">Pages read: {pages.map((source, i) => <span key={source.url}>{i > 0 && (i === pages.length - 1 ? ' and ' : ', ')}<a href={source.url} target="_blank" rel="noopener noreferrer">{host(source.url) + new URL(source.url).pathname.replace(/\/$/, '')}</a></span>)}, on {[...new Set(pages.map(source => dayOf(source.checked)))].join(', ')}.</p>
    <p className="ctv-note">Product names belong to their owners and only identify their products. Nightmail isn’t affiliated with them.</p>
    <h2>More comparisons: {groupOf(c).title.toLowerCase()}</h2>
    <ul className="ctv-more">{neighbours(c).map(other => <li key={other.n}><a href={pathOf(other.comparison, to)}>Nightmail vs {other.comparison.offer.vendor}</a></li>)}</ul>
  </section>
}

/** The page's end: the homepage's links, the other price pages, and (with a guide) the guide. */
function End({ here, guide }: { here: string; guide?: boolean }) {
  return <footer className="ctv-end">
    <nav aria-label="Site links">
      <a href="/">Home</a>
      {guide && <a href="/compare">Compare</a>}
      {PRICE_LINKS.filter(([path]) => path !== here && !(guide && path.startsWith('/compare/'))).map(([path, label]) => <a key={path} href={path}>{label}</a>)}
      <a href="/docs">API docs</a><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a>
    </nav>
  </footer>
}
/** The wordmark in the corner, for a page with no set (whose badge is the way home). */
const Corner = () => <header className="ctv-corner"><a href="/" aria-label="nightmail home"><NightmailWordmark /></a></header>
/** A page's room: the dark the set stands in, whatever the system's theme. */
const Room = ({ direction, children }: { direction: string; children: ReactNode }) => <div className="ctv" data-direction={direction}>{children}</div>

// ---------------------------------------------------------------- 1. One channel per competitor

/** The set, tuned to this comparison's channel: the two bills side by side on the glass; its keys tune to the seven
 *  channels beside it, and the line under the table flips one channel either way. The page in words follows. */
export function ChannelPage({ c }: { c: Comparison }) {
  const channel = channelOf(c.slug), { prev, next } = around(channel.n), bill = billAt(c, middle(c))
  const flip = (to: Channel, dir: 'prev' | 'next') => <a className="ctv-flip" data-dir={dir} href={pathOf(to.comparison, 1)}><span className="ctv-flip-ch">{chLabel(to.n)}</span> <span>{to.comparison.offer.vendor}</span></a>
  return <Room direction="channel">
    <main>
      <Stage c={c} keys={{ channel, to: 1 }} screen={<PairScreen c={c} bill={bill} channel={channel} />}>
        <nav className="ctv-flips" aria-label="Other channels">{flip(prev, 'prev')}{flip(next, 'next')}</nav>
      </Stage>
      <div className="ctv-col">
        <h1 className="ctv-h1">{claim(c).replaceAll('\u00a0', ' ')}</h1>
        <Words c={c} to={1} />
      </div>
    </main>
    <End here={c.path} />
  </Room>
}

// ---------------------------------------------------------------- 2. The verdict first

/** The answer, before anything else: both bills at the comparison's middle size and the day they were read, in the set's
 *  type, as one sentence a person or an assistant can quote (its words are sentence case; the caps are CSS). */
export function verdictWords(c: Comparison) {
  const b = billAt(c, middle(c))
  return { ours: `Nightmail ${b.ours}.`, theirs: `${c.offer.vendor} ${theirs(b)}.`, at: `${perWords(c, b.size).toLowerCase().replace(/^per/, 'Per')} a month, checked ${checkedDay(c)}.` }
}
function Verdict({ c, as: Tag = 'h1' }: { c: Comparison; as?: 'h1' | 'p' }) {
  const v = verdictWords(c)
  return <Tag className="ctv-verdict"><span data-ours="">{v.ours}</span> <span>{v.theirs}</span> <span className="ctv-verdict-at">{v.at}</span></Tag>
}
export function VerdictPage({ c }: { c: Comparison }) {
  const sizes = ([0, 2] as const).map(i => billAt(c, sizeOf(c, i)))
  return <Room direction="verdict">
    <Corner />
    <main className="ctv-col">
      <div className="ctv-answer">
        <Verdict c={c} />
        <p className="ctv-also">{sizes.map((b, i) => <span key={b.size}>{i > 0 && ' '}At {sizeWords(c, b.size)}: Nightmail {b.ours}, {c.offer.vendor} {theirs(b)}.</span>)}</p>
        <Label c={c} under alone />
        <Consent />
      </div>
      <h2 className="ctv-h1 ctv-h1-sub">Nightmail vs {c.offer.vendor}</h2>
      <Words c={c} to={2} />
    </main>
    <End here={c.path} />
  </Room>
}
/** The link preview's picture: the verdict alone, on the room's dark, 1200 x 630 (scripts make a JPEG of it). */
export function VerdictCard({ c }: { c: Comparison }) {
  return <Room direction="card"><div className="ctv-card"><Verdict c={c} as="p" /><p className="ctv-card-mark"><NightmailWordmark /></p></div></Room>
}

// ---------------------------------------------------------------- 3. The dial that prints your bill

/** The top knob is a volume dial over the vendor's own sizes (its steps): turned (dragged round, pressed to step, or with
 *  the arrow keys, Home and End) it prints both bills at that size on the glass. dial.js turns it; without the script it
 *  rests at the middle size, and every size's figures are in the table under it. */
export function DialPage({ c, script }: { c: Comparison; script?: string }) {
  const opening = c.steps.includes(middle(c)) ? middle(c) : c.steps.find(step => step >= middle(c)) ?? c.steps.at(-1)!
  const i = c.steps.indexOf(opening), bill = billAt(c, opening)
  const steps = c.steps.map(size => { const b = billAt(c, size); return [perWords(c, size), b.ours, theirs(b), upper(`${c.offer.vendor} ${b.plan ?? ''}`.trim()), `${sizeWords(c, size)}: Nightmail ${b.ours}, ${c.offer.vendor} ${theirs(b)}`] })
  const angle = (k: number) => -140 + 280 * k / (c.steps.length - 1)
  const dial = <div className="chy-knob ctv-dial" role="slider" tabIndex={0} aria-label="Emails a month" aria-valuemin={0} aria-valuemax={c.steps.length - 1} aria-valuenow={i} aria-valuetext={steps[i]![4]}
    data-dial={JSON.stringify(steps)} style={{ ...at(BUTTON_X, KNOB_Y[0]!, DIAL, DIAL * SET.width / SET.height), '--turn': `${angle(i)}deg` } as CSSProperties}>
    <span className="chy-dial" style={{ backgroundImage: `url(${knob})` }} /><span className="chy-dial-light" />
  </div>
  return <Room direction="dial">
    <main>
      <Stage c={c} dial={dial} screen={<DialScreen c={c} bill={bill} at={i} />}>
        <p className="ctv-hint">Turn the top dial: {formatCount(c.steps[0]!)} to {formatCount(c.steps.at(-1)!)} {UNITS[c.offer.unit].size}.</p>
      </Stage>
      <div className="ctv-col">
        <h1 className="ctv-h1">{claim(c).replaceAll('\u00a0', ' ')}</h1>
        <Words c={c} to={3} />
      </div>
    </main>
    <End here={c.path} />
    {script && <script src={script} defer />}
  </Room>
}

// ---------------------------------------------------------------- 4. The TV guide

const short = (n: number) => n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${+(n / 1_000).toFixed(0)}K` : String(n)
const Size = ({ n }: { n: number }) => <><span className="ctv-wide">{formatCount(n)}</span><span className="ctv-narrow">{short(n)}</span></>

/** The day the newest of these comparisons was read: the guide's date. */
export const guideChecked = () => dayOf(CHANNELS.map(channel => channel.comparison.offer.checked).sort().at(-1)!)

/** /compare: every comparison as a channel, in a programme guide (the SEO audit's spec for the hub). First the ranked
 *  channel the set is showing: the sending APIs by what 100,000 emails a month cost on each, at three sizes as a guide's
 *  hours, Nightmail's row first. Then the three groups, channel by channel, each a listing: the comparison's page, how the
 *  vendor charges, both bills at the size its page opens at, with the vendor's plan, its headline and the day read. */
export function GuidePage() {
  const ranked = GUIDE[0]!, resend = channelOf('resend').comparison
  return <Room direction="guide">
    <main>
      <Stage c={resend} screen={<GuideScreen />} />
      <div className="ctv-col ctv-col-wide">
        <h1 className="ctv-h1">Nightmail compared with {CHANNELS.length} email services</h1>
        <p className="ctv-lead">Each channel is one comparison: what a month costs on Nightmail and on the other service, from that service’s own pricing page, last read {guideChecked()}. In it: {listOf(GROUPS.map(group => `${CHANNELS.filter(channel => channel.comparison.focus === group.focus).length} ${group.noun}`))}.</p>
        <section className="ctv-guide" id="ranked" aria-labelledby="ranked-title">
          <h2 id="ranked-title">Cheapest at {formatCount(ranked.columns[1]!)} emails a month? {ranked.rows.length} sending APIs priced</h2>
          <p className="ctv-ranked-says">Nightmail costs less than each of them at every size shown, as read on each one’s own pricing page on {guideChecked()}.</p>
          <table className="ctv-grid">
            <caption>Sizes in {ranked.unit}. Nightmail first, then each service from the cheapest at {formatCount(ranked.columns[1]!)} to the dearest. No figure where the service’s page prices no plan at that size.</caption>
            <thead><tr><th scope="col">Channel</th>{ranked.columns.map(n => <th key={n} scope="col"><Size n={n} /></th>)}</tr></thead>
            <tbody>
              <tr data-ours=""><th scope="row"><span className="ctv-ch" /><span>Nightmail</span></th>{ranked.ours.map((text, i) => <td key={i}>{text}</td>)}</tr>
              {ranked.rows.map(row => <tr key={row.channel.n}>
                <th scope="row"><a href={pathOf(row.channel.comparison, 4)}><span className="ctv-ch">{String(row.channel.n).padStart(2, '0')}</span><span>{row.channel.comparison.offer.vendor}</span></a></th>
                {row.bills.map((bill, i) => <td key={i}>{theirs(bill)}</td>)}
              </tr>)}
            </tbody>
          </table>
        </section>
        {GROUPS.map(group => <section key={group.id} className="ctv-guide" id={group.id} aria-labelledby={`${group.id}-title`}>
          <h2 id={`${group.id}-title`}>{group.title}</h2>
          <ol className="ctv-listings">{CHANNELS.filter(channel => channel.comparison.focus === group.focus).map(channel => <Listing key={channel.n} channel={channel} />)}</ol>
        </section>)}
        <p className="ctv-note">List prices before tax, monthly billing, no promotions: each service’s cheapest plan that holds the size, or pay-as-you-go where that costs less, as read on its own pricing page. Product names belong to their owners and only identify their products. Nightmail isn’t affiliated with them.</p>
      </div>
    </main>
    <End here="/compare" />
  </Room>
}
/** One channel's listing in the guide, as a programme's in a TV guide: its number, its title (the comparison's page), the
 *  size it opens at as its slot, both bills, and how the vendor charges, the headline and the day read as its line. */
function Listing({ channel }: { channel: Channel }) {
  const c = channel.comparison, b = billAt(c, middle(c))
  return <li className="ctv-listing">
    <span className="ctv-listing-ch">{String(channel.n).padStart(2, '0')}</span>
    <div>
      <p className="ctv-listing-head"><a href={pathOf(c, 4)}>Nightmail vs {c.offer.vendor}</a><span className="ctv-listing-bills">{sizeWords(c, b.size)}: <span data-ours="">Nightmail {b.ours}</span>, {c.offer.vendor} {theirs(b)}{b.plan ? ` (${b.plan})` : ''}</span></p>
      <p className="ctv-listing-line">{c.lead} {claim(c).replaceAll('\u00a0', ' ')}, read {checkedDay(c)}.</p>
    </div>
  </li>
}

/** A comparison in the guide: where it is in it (its section, its channel, the channels either side), its row of the guide
 *  beside Nightmail's, and the page in words. */
export function GuideComparisonPage({ c }: { c: Comparison }) {
  const channel = channelOf(c.slug), { prev, next } = around(channel.n)
  const section = GUIDE.find(s => s.rows.some(row => row.channel === channel))!, row = section.rows.find(r => r.channel === channel)!
  const flip = (to: Channel, dir: 'prev' | 'next') => <a className="ctv-flip" data-dir={dir} href={pathOf(to.comparison, 4)}><span className="ctv-flip-ch">{chLabel(to.n)}</span> <span>{to.comparison.offer.vendor}</span></a>
  return <Room direction="guide-page">
    <Corner />
    <main className="ctv-col">
      <nav className="ctv-crumbs" aria-label="Breadcrumb"><a href="/compare">Compare</a><span aria-hidden="true">/</span><a href={`/compare#${groupOf(c).id}`}>{groupOf(c).title}</a><span aria-hidden="true">/</span><span aria-current="page">{chLabel(channel.n)} {c.offer.vendor}</span></nav>
      <h1 className="ctv-h1">{claim(c).replaceAll('\u00a0', ' ')}</h1>
      <table className="ctv-grid ctv-grid-one">
        <caption>Sizes in {section.unit}. {c.offer.vendor}’s prices checked {checkedDay(c)}.</caption>
        <thead><tr><th scope="col">{chLabel(channel.n)}</th>{section.columns.map(n => <th key={n} scope="col"><Size n={n} /></th>)}</tr></thead>
        <tbody>
          <tr data-ours=""><th scope="row"><span className="ctv-ch" /><span>Nightmail</span></th>{section.ours.map((text, i) => <td key={i}>{text}</td>)}</tr>
          <tr><th scope="row"><span className="ctv-ch">{String(channel.n).padStart(2, '0')}</span><span>{c.offer.vendor}</span></th>{row.bills.map((bill, i) => <td key={i}>{theirs(bill)}</td>)}</tr>
        </tbody>
      </table>
      <Label c={c} under alone />
      <Consent />
      <nav className="ctv-flips ctv-flips-guide" aria-label="Other channels">{flip(prev, 'prev')}{flip(next, 'next')}</nav>
      <Words c={c} to={4} />
    </main>
    <End here={c.path} guide />
  </Room>
}
