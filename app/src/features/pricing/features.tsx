import { memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { routeScreen, SCREENS } from '../home/screens'
import { Flaps } from './flaps'
import { Bolts, reducedMotion, useReplay } from './eggs'
import { play } from './sound'
import { PANELS } from './panels'
import { formatCount, nightmail, type Comparison, type PanelId } from './prices'
import { RAMP } from '../../../../api/src/standing-model'

// What else Nightmail does, under a comparison's board: one wall of the homepage machine's pale concrete, cast in
// panels as the machine's face is, a panel to each thing the product does with a display set into it and a few words
// lettered under it (board.css). On a screen, the homepage's own depiction of that job (home/screens.tsx: the sample
// mail, the API call, the agent's tools, the rule and its log); in the others, a made thing: split-flap figures or the
// team's paper tags. Every claim is the product's as shipped (the billing code's figures come from prices.ts). Each
// comparison's entry sets which panels it shows and in what order, on the wall's slots (SLOTS): Mailchimp's readers
// first see the list, the contacts and the team; Resend's the API, the allowances and the domain. (Seven each: a wall,
// not a catalogue.) On a wide page the panels are set on a 12-column grid by row and column; narrower, two across with the
// wide ones across both; on a phone, one under another in the same order.
// Three screens move while they are in view, as on the homepage (the campaign's meter, the agent's reply, the log's
// tape), and a panel's flaps turn over as it comes into view; with reduced motion nothing does (board.css).

type Feature = { face: 'screen' | 'object'; show: ReactNode }

const TEAM = [['Dana', 'Owner'], ['Zahir', 'Admin'], ['Bertram', 'Member'], ['Mina', 'Member']] as const
// The workspace's built-in domain (api/src/builtin-domain.ts), then a domain's records as the product lists them
// (api/src/domains/hosted.ts, readiness): three DKIM CNAMEs, MAIL FROM's SPF, the DMARC it checks for, and the MX that receives.
const RECORDS = [['Built-in', 'acme-k7.nightmail.email'], ['DKIM', 'x7k2._domainkey'], ['DKIM', 'p4qd._domainkey'], ['SPF', 'email'], ['DMARC', '_dmarc'], ['MX', 'acme.example']] as const
// A campaign's review (api/src/sending.ts, readiness) and the first hours of the ramp (api/src/standing-model.ts, RAMP).
const READY = [['DMARC', 'acme.example', '✓'], ['List', 'risky addresses skipped', '✓'], ...RAMP.steps.slice(0, 3).map((step, i) => [`Hour ${i + 1}`, `${formatCount(step.ceilingPerHour)} recipients`, i < 2 ? '✓' : '…'])] as const
// What list hygiene flags (api/src/list-hygiene.ts, RISKS): campaigns skip those, and send to the rest.
// (On acme.example, the page's other screens' domain: example.com and example.net are the CLS gate's seeded mailboxes,
// which a page may not spell out.)
const HYGIENE = [['OK', 'dana@acme.example', '✓'], ['Typo', 'zahir@gmial.com', 'skip'], ['Temp', 'k9@mailinator.com', 'skip'], ['Dead', 'old@acme.example', 'skip'], ['OK', 'mina@acme.example', '✓']] as const
const free = formatCount(nightmail.freeSent), freeReceived = formatCount(nightmail.freeReceived), flaps = Math.max(free.length, freeReceived.length)
/** A paper tag on its pin: it swings when the pointer brushes it or it's tapped (and rustles when tapped). */
function Tag({ name, role, k }: { name: string; role: string; k: number }) {
  const [swing, replay] = useReplay()
  return <span className="ft-tag" data-swing={swing} style={{ '--k': k } as CSSProperties}
    onPointerEnter={event => { if (event.pointerType === 'mouse') replay() }} onClick={() => { replay(); play('tags') }}><b>{name}</b><span>{role}</span></span>
}

// Each panel's display (its words are panels.ts's).
const FEATURES: Record<PanelId, Feature> = {
  send: { face: 'screen', show: <div className="ft-screen ft-send">
    {SCREENS.send}
    <div className="ft-hooks">{['email.sent', 'email.delivered'].map(event => <p key={event}><span>Webhook</span><b>{event}</b><em>200</em></p>)}</div>
  </div> },
  campaign: { face: 'screen', show: <div className="ft-screen ft-campaign">{SCREENS.campaign}</div> },
  contacts: { face: 'object', show: <div className="ft-flapboard">
    <p><span>Contacts</span><Flaps text="100,000" width={7} end className="ft-flaps" /></p>
    <p><span>Charge</span><Flaps text="$0" width={7} end className="ft-flaps ft-lit" /></p>
  </div> },
  team: { face: 'object', show: <div className="ft-rail">
    {TEAM.map(([name, role], i) => <Tag key={name} name={name} role={role} k={i} />)}
  </div> },
  free: { face: 'object', show: <div className="ft-flapboard">
    <p><Flaps text={free} width={flaps} end className="ft-flaps ft-lit" /><span>Sent</span></p>
    <p><Flaps text={freeReceived} width={flaps} end className="ft-flaps ft-lit" /><span>Received</span></p>
  </div> },
  receive: { face: 'screen', show: <div className="ft-screen ft-receive">{SCREENS.receive}</div> },
  agent: { face: 'screen', show: <div className="ft-screen ft-agent">{SCREENS.agent}</div> },
  route: { face: 'screen', show: <div className="ft-screen ft-route">{routeScreen(6)}</div> },
  domain: { face: 'screen', show: <div className="ft-screen ft-dns ft-dns-wide">
    {RECORDS.map(([kind, name]) => <p key={name}><span>{kind}</span><b>{name}</b><em>✓</em></p>)}
  </div> },
  ready: { face: 'screen', show: <div className="ft-screen ft-dns">
    {READY.map(([kind, name, mark]) => <p key={kind}><span>{kind}</span><b>{name}</b><em data-skip={mark === '…' || undefined}>{mark}</em></p>)}
  </div> },
  hygiene: { face: 'screen', show: <div className="ft-screen ft-dns">
    {HYGIENE.map(([kind, name, mark]) => <p key={name}><span>{kind}</span><b>{name}</b><em data-skip={mark === 'skip' || undefined}>{mark}</em></p>)}
  </div> },
}

/** The wall's slots, in reading order, each panel's place on the wide grid: row start, column start, row end, column end
 *  (of 12 columns). The same shape for every comparison (its entry names the panels, prices.ts PANEL_SLOTS): the lead
 *  panel with two beside it, one across the wall, and two beside the rules' log, whose tape runs as long as they stand. */
const SLOTS = ['1 / 1 / 3 / 8', '1 / 8 / 2 / 13', '2 / 8 / 3 / 13', '3 / 1 / 4 / 13', '4 / 1 / 5 / 6', '5 / 1 / 6 / 6', '4 / 6 / 6 / 13']

/** A panel of the wall: held by four bolts, a quarter turn a click; with all four turned it slips on its last and
 *  hangs from its top corner, then is put back and bolted again. The campaign's screen stamps SENT when it's clicked. */
function Panel({ id, at, lead, wide, k }: { id: PanelId; at: string; lead: boolean; wide: boolean; k: number }) {
  const { face, show } = FEATURES[id], { title, line } = PANELS[id]
  const ref = useRef<HTMLElement>(null), loose = useRef(new Set<number>())
  const [drop, setDrop] = useState<{ x: number; y: number } | null>(null), [stamp, replayStamp] = useReplay()
  const turn = (corner: number) => {
    loose.current.add(corner)
    if (loose.current.size < 4 || drop) return
    loose.current.clear()
    if (reducedMotion()) return
    // (The panel's own concrete, lined up with the wall's: where it sits in the slab.)
    const card = ref.current!, slab = card.closest('.ft-slab')!.getBoundingClientRect(), box = card.getBoundingClientRect()
    setDrop({ x: box.left - slab.left, y: box.top - slab.top })
    play('drop')
    window.setTimeout(() => { setDrop(null); play('bolt') }, 2600)
  }
  const thump = id === 'campaign' ? () => { replayStamp(); play('stamp') } : undefined
  return <article ref={ref} className="ft-card" data-face={face} data-feature={id} data-lead={lead || undefined} data-wide={wide || undefined} data-drop={drop ? '' : undefined}
    style={{ '--at': at, '--k': k, ...drop ? { '--px': `${drop.x}px`, '--py': `${drop.y}px` } : {} } as CSSProperties}>
    <div className="ft-panel">
      <Bolts onTurn={turn} />
      <div className="ft-show" aria-hidden="true" data-stamp={stamp} onClick={thump}>{show}</div>
      <div className="ft-words"><h3>{title}</h3><p>{line}</p></div>
    </div>
  </article>
}

// (The wall doesn't change with the board's fader or its flaps: it isn't drawn again for them.)
export const Features = memo(function Features({ comparison: c }: { comparison: Comparison }) {
  const root = useRef<HTMLElement>(null)
  // A panel's screen moves, and its flaps turn, while it is in view.
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const observer = new IntersectionObserver(entries => { for (const entry of entries) (entry.target as HTMLElement).toggleAttribute('data-on', entry.isIntersecting) }, { threshold: .25 })
    for (const card of root.current!.querySelectorAll('.ft-card')) observer.observe(card)
    return () => observer.disconnect()
  }, [])
  const layout = c.panels.map((id, k) => [id, SLOTS[k]!] as const)
  return <section className="ft" ref={root} aria-labelledby="ft-title">
    <div className="ft-slab">
      <h2 id="ft-title" className="ft-title">Also in the box.</h2>
      <div className="ft-grid">{layout.map(([id, at], k) => {
        // (A panel across more than half the wide grid is across both columns on a tablet.)
        const [, from, , to] = at.split('/').map(Number)
        return <Panel key={id} id={id} at={at} k={k} lead={k === 0} wide={to! - from! > 6} />
      })}</div>
    </div>
  </section>
})
