import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { SignInConsent } from '../../components/LegalLinks'
import { Cells, CELLS, Claim, keys, Mark, opensPainted, useHall, type Start } from './board'
import { calculatorPath, CheckedPages, Ours, PRESETS, sizeOf, Terms, type Field } from './content'
import { Bolts } from './eggs'
import { play } from './sound'
import { FlapRow } from './splitflap'
import { COMPARISONS, OFFERS } from './compare'
import { billMath, count, formatCount, money, nightmail, nightmailBill, ucOf, vendorRows, yearlyFloor, type Usage } from './prices'

// The price calculator (/pricing) in the comparisons' hall (board.tsx, Hall): the board is the answer and the console
// is where the reader sets their numbers. On the board, Nightmail's price for those numbers on large split-flap tiles
// beside the wordmark, then a row for each other vendor with a price read for them (its name, its plan and its price)
// and under each price its bar, all on one scale; the board's small print has Nightmail's arithmetic, what the other
// prices are and the day they were read, and the way to each comparison. A vendor with no price read for the numbers
// leaves its row blank, so the board keeps its shape. On the console: the four numbers in windows cut into the
// concrete, the three sizes as keys (Small, Medium and Large, the Mailchimp comparison's), and Get started; under it,
// Nightmail's pricing terms. Every Nightmail figure carries the usage it prices (Ours), which the pre-merge check reads
// back. (No styles imported here, so the pre-merge check can render it: board.css.)

const FIELDS = [
  { key: 'sent', label: 'Sent a month', name: 'Emails sent a month' },
  { key: 'received', label: 'Received a month', name: 'Emails received a month' },
  { key: 'contacts', label: 'Contacts', name: 'Contacts' },
  { key: 'teammates', label: 'Teammates', name: 'Teammates' },
] as const
type Values = Record<Field, string>
const DEFAULT = PRESETS[1]!.size

/** The rooms the tiles keep, so nothing moves as the numbers do: a vendor's widest price (its pay-as-you-go prices stay
 *  under its last tier's, so the widest is a cent short of that), the longest name; Nightmail's price and the emails
 *  counted keep at least the room of the usual sizes and grow only past them. */
const VENDOR = Math.max(...OFFERS.map(offer => offer.vendor.length))
const THEIRS = Math.max(...OFFERS.flatMap(offer => offer.plans.flatMap(plan => plan.tiers.map(tier => money(tier.cents).length))), ...OFFERS.map(offer => money(Math.max(...offer.plans.flatMap(plan => plan.tiers.map(tier => tier.cents))) - 10).length))
const OURS = 7, COUNTED = 9

/** The calculator's headline, board and console, on the numbers in the address (/pricing?sent=…&received=…&contacts=…&teammates=…). */
export function PricingBoard({ start }: { start?: Start }) {
  const [params, setParams] = useSearchParams()
  const [values, setValues] = useState<Values>(() => Object.fromEntries(FIELDS.map(({ key }) => [key, formatCount(params.has(key) ? count(params.get(key)) : DEFAULT[key])])) as Values)
  const u: Usage = { sent: count(values.sent), received: count(values.received), contacts: count(values.contacts), seats: count(values.teammates) }
  const size = sizeOf(u), preset = PRESETS.find(p => FIELDS.every(({ key }) => p.size[key] === size[key]))
  const change = (next: Values) => {
    setValues(next)
    setParams(Object.fromEntries(FIELDS.map(({ key }) => [key, String(count(next[key]))])), { replace: true, preventScrollReset: true })
  }
  const bill = nightmailBill(u.sent, u.received), floor = yearlyFloor(bill.uc), rows = vendorRows(OFFERS, u)
  const top = [bill.uc, ...rows.map(row => ucOf(row.cents))].reduce((a, b) => b > a ? b : a, 0n)
  const lit = (uc: bigint) => uc === 0n || top === 0n ? 0 : Math.max(1, Math.round(CELLS * Number(uc) / Number(top)))
  const counted = formatCount(u.sent + u.received), slots = OFFERS.map((_, i) => rows[i])
  const { refresh, resend, sounding } = useHall()
  const [painted] = useState(opensPainted), settled = useRef(false), settle = !settled.current && !painted
  useEffect(() => { settled.current = true }, [])
  const flaps = { settle, refresh, sound: sounding }
  // What a screen reader hears, once the reader stops typing for a moment (the board itself is pictures of figures).
  const summary = <>{formatCount(u.sent)} emails sent and {formatCount(u.received)} received a month, {formatCount(u.contacts)} contacts and {formatCount(u.seats)} teammates: Nightmail <Ours sent={u.sent} received={u.received}>{bill.text}</Ours> a month{rows.map(row => `; ${row.offer.vendor} ${row.plan} ${money(row.cents)}`).join('')}.</>
  const [said, setSaid] = useState(summary), key = calculatorPath(u)
  useEffect(() => { const timer = setTimeout(() => setSaid(summary), 700); return () => clearTimeout(timer) }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return <>
    <h1 id="cb-title" className="cb-title"><Claim text="What Nightmail costs at your size" /></h1>
    <div className="cb-hang" aria-hidden="true"><i /><i /></div>
    <div className="cb-board cb-board-calc" onClick={resend}>
      <Bolts />
      <div className="cb-face">
        <p className="sr-only" aria-live="polite">{said}</p>
        <p className="cb-head" aria-hidden="true"><span>A month at</span><FlapRow key={`c${Math.max(COUNTED, counted.length)}`} text={counted} width={Math.max(COUNTED, counted.length)} end className="cb-small" x={[.36, .58]} {...flaps} /><span>emails</span></p>
        <div className="cb-row cb-mine" aria-hidden="true"><Mark className="cb-mark-board" /><FlapRow key={`n${Math.max(OURS, bill.text.length)}`} text={bill.text} width={Math.max(OURS, bill.text.length)} end className="cb-price" size="big" x={[.72, 1]} row={1} {...flaps} /></div>
        <Cells lit={lit(bill.uc)} mine settle={settle} />
        {slots.map((row, i) => <div key={i} className="cb-other" aria-hidden="true">
          <div className="cb-row">
            <span className="cb-who"><FlapRow text={row?.offer.vendor ?? ''} width={VENDOR} className="cb-name" size="name" x={[0, .3]} row={2 + i} {...flaps} /><span className="cb-plan">{row?.plan}</span></span>
            <FlapRow text={row ? money(row.cents) : ''} width={THEIRS} end className="cb-price cb-price-other" size="big" x={[.72, 1]} row={2 + i} {...flaps} />
          </div>
          <Cells lit={row ? lit(ucOf(row.cents)) : 0} settle={settle} />
        </div>)}
        {/* The small print: Nightmail's arithmetic; each vendor's plan, with its comparison; when the prices were read. */}
        <div className="cb-foot cb-foot-calc">
          <p>
            <span>Sent: {billMath(bill.sent)} = <Ours sent={u.sent} received={0}>{bill.sent.text}</Ours></span>
            <span>Received: {billMath(bill.received)} = <Ours sent={0} received={u.received}>{bill.received.text}</Ours></span>
            <span>Contacts and teammates: no charge, <Ours sent={0} received={0}>{nightmailBill(0, 0).text}</Ours></span>
          </p>
          <p>
            <span>Each vendor’s cheapest plan, list price</span>
            <span>{rows.length ? <CheckedPages offers={rows.map(row => row.offer)} /> : '\u00a0'}</span>
            <span>Compare: {COMPARISONS.map((comparison, i) => <span key={comparison.path}>{i > 0 && ' · '}<Link to={comparison.path}>{comparison.vendor}</Link></span>)}</span>
          </p>
        </div>
      </div>
    </div>
    {/* The console: the reader's four numbers, the three sizes, and Get started. */}
    <div className="cb-console cb-console-calc" role="group" aria-label="Your numbers" {...keys}>
      <Bolts />
      {FIELDS.map(({ key, label, name }) => <label key={key} className="cb-field">
        <span className="cb-stencil" aria-hidden="true">{label}</span><span className="sr-only">{name}</span>
        <input className="cb-input" name={key} inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={14} value={values[key]}
          onChange={event => change({ ...values, [key]: event.target.value })}
          onBlur={() => { const tidy = formatCount(count(values[key])); if (tidy !== values[key]) setValues({ ...values, [key]: tidy }) }} />
      </label>)}
      <div className="cb-presets" role="group" aria-label="Sizes">
        {PRESETS.map(p => <button key={p.name} type="button" className="cb-preset" aria-pressed={preset === p}
          onClick={() => { play('key'); change(Object.fromEntries(FIELDS.map(({ key }) => [key, formatCount(p.size[key])])) as Values) }}>{p.name}</button>)}
      </div>
      {start?.button('cb-key cb-key-start')}
    </div>
    {start && !start.signedIn && <SignInConsent className="cb-consent cb-consent-hero" />}
    <div className="cb-print">
      <p>Nightmail charges {nightmail.perThousand} per 1,000 emails sent or received, after {formatCount(nightmail.freeSent)} sent and {formatCount(nightmail.freeReceived)} received free every month.</p>
      <Terms floor={floor} />
    </div>
  </>
}
