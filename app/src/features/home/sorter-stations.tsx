import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { ArrowRight, LoaderCircle } from 'lucide-react'
import { Link } from 'react-router'
import { SignInConsent } from '../../components/LegalLinks'
import { AnomalyLogo } from '../../components/AnomalyLogo'
import { reducedMotion, type HomeProps } from '.'
import { DX, DY, type Plan } from './sorter/plan'

// Under the slab the machine stands on, its eight tubes run on down the page and one by one bend in to an appliance:
// the places mail can go. Scrolling carries a capsule down each tube, round the bend and into the appliance's tray,
// and then the letter in it arrives the way it does in the product: a pigeonhole fills and a row appears in the
// Inbox, a mail app on a monitor gets the message, a teleprinter prints an agent's turn, a ritual's lamps come on line
// by line, a switchboard posts a webhook, a press runs a campaign off, a thread grows, a ledger tape prints the logs.
// Everything is driven by how far the page has scrolled (--q on each unit, 0 to 1), with transforms, opacity and
// clipping only, so nothing shifts; with reduced motion every unit shows its finished state. The letters are from
// the sorter's own set.
type Kind = 'inbox' | 'imap' | 'agent' | 'ritual' | 'endpoint' | 'campaign' | 'thread' | 'logs'
type Station = { kind: Kind; tube: number; name: string; line: string; plate: string; w: number; h: number; up: number; down: number; port: number }
// `up` and `down` are what stands over or hangs under the appliance's box (paper, a stand); `port` is how far down its
// side the tube comes in.
const STATIONS: Station[] = [
  { kind: 'inbox', tube: 0, name: 'Inbox', line: 'Every address keeps its own threads.', plate: 'Inbox', w: 430, h: 296, up: 0, down: 0, port: .18 },
  { kind: 'imap', tube: 4, name: 'IMAP and SMTP', line: 'Or open the same inbox in a mail app.', plate: 'IMAP', w: 408, h: 240, up: 0, down: 40, port: .5 },
  { kind: 'agent', tube: 1, name: 'Agent inboxes', line: 'Addresses your agents read and answer over MCP.', plate: 'Agents', w: 420, h: 96, up: 168, down: 0, port: .5 },
  { kind: 'ritual', tube: 5, name: 'Rituals', line: 'Short scripts that run on mail as it arrives.', plate: 'Rituals', w: 446, h: 226, up: 0, down: 0, port: .5 },
  { kind: 'endpoint', tube: 2, name: 'Endpoints', line: 'Slack, Discord, a webhook or a forward.', plate: 'Endpoints', w: 446, h: 262, up: 0, down: 0, port: .5 },
  { kind: 'campaign', tube: 6, name: 'Campaigns', line: 'One send to a whole audience, at the same price.', plate: 'Campaigns', w: 430, h: 246, up: 34, down: 0, port: .5 },
  { kind: 'thread', tube: 3, name: 'Threads', line: 'Reply from the address the mail came to.', plate: 'Threads', w: 384, h: 262, up: 64, down: 0, port: .5 },
  { kind: 'logs', tube: 7, name: 'Logs', line: 'And every message, sent or received, is on record.', plate: 'Logs', w: 420, h: 88, up: 0, down: 186, port: .5 },
]

/** A window of a unit's progress: the element's own --t runs 0 to 1 while --v goes from `from` to `to`. */
const step = (from: number, to: number, extra?: CSSProperties) => ({ '--from': from, '--to': to, ...extra }) as CSSProperties

export function Stations({ plan: p, onSignIn, onSignInIntent, busy }: { plan: Plan | null } & Pick<HomeProps, 'onSignIn' | 'onSignInIntent' | 'busy'>) {
  const root = useRef<HTMLElement>(null)
  // One pass per frame while scrolling: how far each unit has come up the page.
  useEffect(() => {
    const units = [...root.current!.querySelectorAll<HTMLElement>('.srt-unit')]
    if (reducedMotion()) { for (const unit of units) unit.style.setProperty('--q', '1'); return }
    let frame = 0
    const last = units.map(() => -1)
    const measure = () => {
      frame = 0
      const view = window.innerHeight
      units.forEach((unit, i) => {
        const box = unit.getBoundingClientRect()
        // 0 as the unit comes in at the bottom of the window, 1 once its top stands at about 40% of the window's height.
        const q = Math.round(Math.min(1, Math.max(0, (view * 1.04 - box.top) / (view * .62))) * 500) / 500
        if (q !== last[i]) { last[i] = q; unit.style.setProperty('--q', String(q)) }
      })
    }
    const queue = () => { frame ||= requestAnimationFrame(measure) }
    measure()
    window.addEventListener('scroll', queue, { passive: true }); window.addEventListener('resize', queue)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', queue); window.removeEventListener('resize', queue) }
  }, [p])

  if (!p) return <section className="srt-stations" ref={root} aria-label="Where mail goes" />
  const phone = p.phone, r = p.tubeR, wide = r * 2, depth = phone ? 40 : 60, dx = -DX * depth, dy = DY * depth
  // Each appliance stands between the two fours of tubes, a little towards the side its own tube comes from.
  const inner = Math.min(...p.drops.slice(4)) - Math.max(...p.drops.slice(0, 4)), room = inner - 2 * (phone ? 20 : 74), lean = phone ? 0 : Math.min(46, Math.max(0, (room - 430) / 2))
  const captionH = phone ? 58 : 66, gap = phone ? 84 : 116, trayW = phone ? 0 : 42
  let top = phone ? 96 : 110
  const units = STATIONS.map(station => {
    const w = Math.min(station.w, room), left = station.tube < 4
    const boxLeft = Math.round(p.ox - w / 2 + (left ? -lean : lean) + dx / 2), boxTop = top + captionH + dy + 18 + station.up
    const unit = { station, w, left, top, boxLeft, boxTop: boxTop - top, port: boxTop + Math.round(station.h * station.port), end: left ? boxLeft - dx * .5 - trayW : boxLeft + w + trayW }
    top = boxTop + station.h + station.down + gap
    return unit
  })
  const height = top + (phone ? 250 : 240)
  // The tubes. Each side's four start where they left the slab's lip; after each appliance on that side the tubes that
  // are left step in one place towards the column (the inner ones first, so none crosses another), and the innermost
  // then bends in to the next appliance. On a phone they are a ribbon at each edge and run straight.
  const pipes = units.map(({ station, left, port, end }) => {
    const side = left ? 0 : 4, n = station.tube - side, slot = (j: number) => p.drops[side + j], points: Pt[] = [[slot(phone ? n : n), 0]]
    if (!phone) for (let m = 0; m < n; m++) { const y = units.find(u => u.station.tube === side + m)!.port + 78 + (n - m - 1) * (wide + 16); points.push([slot(n - m), y], [slot(n - m - 1), y]) }
    const x = points.at(-1)![0]
    points.push([x, port], [end + (left ? 1 : -1) * (phone ? 8 : trayW - 20), port])
    return { tube: station.tube, points, x, tray: end }
  })
  const vars = { '--srt-r': `${r}px`, '--srt-pipe': `${wide}px`, '--srt-dx': `${dx}px`, '--srt-dy': `${dy}px`, height } as CSSProperties
  return <section className="srt-stations" ref={root} style={vars} data-phone={phone || undefined} aria-label="Where mail goes">
    <div className="srt-pipes" aria-hidden="true">
      {pipes.map(({ tube, points, tray }) => <Pipe key={tube} points={points} wide={wide} bend={wide * 1.7} tray={phone ? null : [tray, trayW, tube < 4]} />)}
    </div>
    {units.map(({ station, w, left, top, boxLeft, boxTop }, k) => <div key={station.kind} className="srt-unit" data-kind={station.kind} data-side={left ? 'l' : 'r'} style={{ top, '--srt-w': `${w}px`, '--srt-h': `${station.h}px` } as CSSProperties}>
      {/* The capsule rides the last stretch of its tube, round the bend and out into the tray. */}
      <span className="srt-capsule" style={{ offsetPath: `path("${trail(pipes[k].points, wide * 1.7, phone ? 300 : 560, top)}")` }} aria-hidden="true" />
      <div className="srt-caption" style={{ left: boxLeft - dx, width: w + dx }}>
        <h2>{station.name}</h2>
        <p>{station.line}</p>
      </div>
      <div className="srt-box" style={{ left: boxLeft, top: boxTop }}>
        {APPLIANCES[station.kind]}
        <span className="srt-plate" aria-hidden="true">{station.plate}</span>
        <span className="srt-lamp" aria-hidden="true" />
      </div>
    </div>)}
    <footer className="srt-end">
      <p className="srt-end-price"><b>$0.20</b> per 1,000 emails, sent or received.</p>
      <button type="button" className="srt-cta srt-end-cta" disabled={busy} aria-busy={busy || undefined} onClick={onSignIn} onPointerDown={onSignInIntent}>
        <span className="srt-cta-label">Get started{busy ? <LoaderCircle className="ui-spinner" size={16} aria-hidden="true" /> : <ArrowRight className="srt-cta-arrow" size={16} strokeWidth={2} aria-hidden="true" />}</span>
      </button>
      <SignInConsent className="srt-end-consent" />
      <nav aria-label="Site links"><a className="srt-by" href="https://anoma.ly" target="_blank" rel="noopener" title="Anomaly (opens in a new tab)">by <AnomalyLogo height={18} /></a><a href="/docs">API docs</a><Link to="/legal/terms">Terms</Link><Link to="/legal/privacy">Privacy</Link></nav>
    </footer>
  </section>
}

type Pt = [number, number]
const corners = (points: Pt[], bend: number) => points.map((v, i) => i === 0 || i === points.length - 1 ? 0 : Math.min(bend, Math.hypot(v[0] - points[i - 1][0], v[1] - points[i - 1][1]) / 2, Math.hypot(points[i + 1][0] - v[0], points[i + 1][1] - v[1]) / 2))

/** A tube that runs down the page and across it at right angles: its straight runs, a quarter ring at each corner, a
 * collar either side of its last bend, and the tray at its end. */
function Pipe({ points, wide, bend, tray }: { points: Pt[]; wide: number; bend: number; tray: [number, number, boolean] | null }) {
  const R = corners(points, bend), last = points.length - 1, out = wide / 2
  return <>
    {points.slice(0, -1).map((a, i) => {
      // The glass ends where the tray begins: the capsule comes out into the open.
      const b: Pt = i === last - 1 && tray ? [tray[0], points[last][1]] : points[i + 1]
      if (a[0] === b[0]) return <span key={`s${i}`} className="srt-pipe" style={{ left: a[0] - out, top: a[1] + R[i], height: Math.max(0, b[1] - R[i + 1] - a[1] - R[i]) }} />
      const s = Math.sign(b[0] - a[0])
      return <span key={`s${i}`} className="srt-pipe srt-pipe-in" style={{ left: s > 0 ? a[0] + R[i] : b[0] + R[i + 1], top: a[1], width: Math.max(0, Math.abs(b[0] - a[0]) - R[i] - R[i + 1]) }} />
    })}
    {points.slice(1, -1).map((v, k) => {
      const i = k + 1, rad = R[i], a = points[i - 1], b = points[i + 1], size = rad + out
      // Down then across: the ring's centre is beside the corner, level with where the bend begins. Across then down: under it.
      if (a[0] === v[0]) { const s = Math.sign(b[0] - v[0]); return <span key={`b${i}`} className="srt-bend" style={{ left: s > 0 ? v[0] - out : v[0] - rad, top: v[1] - rad, width: size, height: size, '--srt-bend': `${rad}px`, '--srt-c': s > 0 ? '100% 0' : '0 0' } as CSSProperties} /> }
      const s = Math.sign(v[0] - a[0])
      return <span key={`b${i}`} className="srt-bend" style={{ left: s > 0 ? v[0] - rad : v[0] - out, top: v[1] - out, width: size, height: size, '--srt-bend': `${rad}px`, '--srt-c': s > 0 ? '0 100%' : '100% 100%' } as CSSProperties} />
    })}
    <span className="srt-ring" style={{ left: points[last - 1][0], top: points[last - 1][1] - R[last - 1] }} />
    <span className="srt-ring srt-ring-in" style={{ left: points[last - 1][0] + Math.sign(points[last][0] - points[last - 1][0]) * R[last - 1], top: points[last][1] }} />
    {tray && <span className="srt-tray" data-side={tray[2] ? 'l' : 'r'} style={{ left: tray[2] ? tray[0] : tray[0] - tray[1], top: points[last][1], width: tray[1] }} />}
  </>
}

/** The last `length` pixels of a tube's way, as a motion path, in the coordinates of the unit it ends at (`top` down the section). */
function trail(points: Pt[], bend: number, length: number, top: number) {
  const R = corners(points, bend)
  let i = points.length - 1, left = length, start: Pt = points[0]
  for (; i > 0; i--) { const a = points[i - 1], b = points[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]); if (d >= left) { const t = left / d; start = [b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t]; break } left -= d }
  let path = `M ${start[0]} ${start[1] - top}`
  for (let k = Math.max(i, 1); k < points.length; k++) {
    const v = points[k], rad = R[k]
    if (!rad) { path += ` L ${v[0]} ${v[1] - top}`; continue }
    const a = points[k - 1], b = points[k + 1], la = Math.hypot(v[0] - a[0], v[1] - a[1]), lb = Math.hypot(b[0] - v[0], b[1] - v[1])
    path += ` L ${v[0] - (v[0] - a[0]) / la * rad} ${v[1] - (v[1] - a[1]) / la * rad - top} Q ${v[0]} ${v[1] - top} ${v[0] + (b[0] - v[0]) / lb * rad} ${v[1] + (b[1] - v[1]) / lb * rad - top}`
  }
  return path
}

const Row = ({ from, subject, when, fresh, style }: { from: string; subject: string; when: string; fresh?: boolean; style?: CSSProperties }) =>
  <div className={fresh ? 'srt-row-mail srt-step srt-fresh' : 'srt-row-mail'} style={style}><i className="srt-dot" /><b>{from}</b><span>{subject}</span><time>{when}</time></div>
const LOGS: [string, string, number][] = [['Received', 'Turn a one-star canteen review into notes', 0], ['Received', 'Your webhook is answering in Latin', .15], ['Delivered', 'We label the sausages by mood now', .3], ['Received', 'Re: can you send me the file again', .45], ['Sent', 'Sending version six. It is the last one.', .6], ['Received', 'Your pager wants to be friends', .75]]

// Each appliance: what stands in, on or under its box. All of it is aria-hidden; the unit's name and line say what it is.
const APPLIANCES: Record<Kind, ReactNode> = {
  // A rack of pigeonholes over a screen: the letter is filed, and its row heads the Inbox.
  inbox: <div className="srt-a" aria-hidden="true">
    <div className="srt-holes">{Array.from({ length: 16 }, (_, i) => <i key={i} className={i === 10 ? 'srt-step srt-filed' : [0, 2, 3, 6, 9, 12, 13, 15].includes(i) ? 'srt-full' : undefined} style={i === 10 ? step(0, .14) : undefined} />)}</div>
    <div className="srt-screen">
      <div className="srt-v-head"><b>Inbox</b><span className="srt-step srt-count" style={step(.2, .4)}><i>2</i><i>3</i></span></div>
      <div className="srt-list">
        <Row fresh from="On-Call Pager" subject="Your pager wants to be friends" when="now" style={step(.16, .5)} />
        <div className="srt-step srt-shift" style={step(.16, .5)}>
          <Row from="Handle Concern" subject="Order confirmed: 6 mugs, 7 handles" when="02:14" />
          <Row from="Nadia Sorrel" subject="Your badge photo is now the wrong you" when="01:40" />
          <Row from="nightly-sync" subject="Your cron job is asking about the point" when="00:03" />
        </div>
      </div>
    </div>
  </div>,
  // A monitor on its stand: the same inbox in a mail app, the count on the folder, the message in the list.
  imap: <div className="srt-a" aria-hidden="true">
    <div className="srt-screen srt-v-imap">
      <div className="srt-app-side"><i /><i /><i /><span className="srt-folder">Inbox<b className="srt-step srt-pop" style={step(.3, .5)}>1</b></span><span>Sent</span><span>Junk</span><span>Archive</span></div>
      <div className="srt-app-list">
        <div className="srt-app-mail srt-step srt-fresh" style={step(.1, .5)}><b>Pantry Assistant</b><span>Your fridge has written a short essay</span><em>Title: On Being Opened. Twelve pages. Tone: considered, angry.</em></div>
        <div className="srt-step srt-shift" style={step(.1, .5)}>
          <div className="srt-app-mail"><b>Mill Row Bakes</b><span>The ovens are taking a vacation</span><em>Three days off. They earned it, we earned it. Bread Tuesday.</em></div>
          <div className="srt-app-mail"><b>Seed Library</b><span>New hours for the seed library</span><em>Open Tuesdays. Closed when we are in the garden.</em></div>
          <div className="srt-app-mail"><b>Boundary Post</b><span>Delivery failed: door was open, which felt wrong</span><em>We respected the door's privacy. The parcel waits outside.</em></div>
        </div>
      </div>
    </div>
    <span className="srt-neck" /><span className="srt-foot" />
  </div>,
  // A teleprinter: the agent's turn comes up out of it on paper, line by line.
  agent: <div className="srt-a" aria-hidden="true">
    <div className="srt-feed"><div className="srt-paper srt-step" style={step(0, .92)}>
      <p><i>agent</i> inboxes.wait()</p>
      <p><i>mail</i> Bertram Quaife: Turn a one-star canteen review into notes</p>
      <p className="srt-quote">Extract the actionable part from 'the soup was a warning'.</p>
      <p><i>agent</i> messages.reply("1. Label the soup.")</p>
      <p><i>mail</i> Reply sent from the inbox's address</p>
    </div></div>
    <div className="srt-keys">{Array.from({ length: 22 }, (_, i) => <i key={i} />)}</div>
  </div>,
  // A console: the ritual on its screen, and a lamp for each thing it does, lit as the line runs.
  ritual: <div className="srt-a" aria-hidden="true">
    <div className="srt-screen srt-v-ritual">
      <pre><span>export default function route(email) {'{'}</span>
        <span className="srt-step srt-run" style={step(.1, .3)}>  if (email.subject.includes("pager")) {'{'}</span>
        <span className="srt-step srt-run" style={step(.4, .56)}>    label("on-call")</span>
        <span className="srt-step srt-run" style={step(.62, .8)}>    endpoints.pager({'{'} text: email.subject {'}'})</span>
        <span>  {'}'}</span>
        <span>{'}'}</span></pre>
    </div>
    <div className="srt-panel">
      <span className="srt-step srt-led" style={step(.24, .34)}>true</span>
      <span className="srt-step srt-led" style={step(.5, .6)}>label</span>
      <span className="srt-step srt-led" style={step(.74, .84)}>endpoint</span>
    </div>
  </div>,
  // A switchboard: the payload, and the line it goes out on.
  endpoint: <div className="srt-a" aria-hidden="true">
    <div className="srt-screen srt-v-endpoint">
      <p className="srt-step srt-type" style={step(.02, .22)}><b>POST</b> hooks.acme.example/mail</p>
      <pre className="srt-step srt-unfold" style={step(.22, .66)}>{'{\n  "type": "message.received",\n  "from": "Delivery Service",\n  "subject": "Your webhook is\n    answering in Latin"\n}'}</pre>
      <p className="srt-step srt-in srt-ok" style={step(.8, .94)}><b>200</b> OK</p>
    </div>
    <div className="srt-panel srt-jacks">
      <span>Slack</span><span>Discord</span><span className="srt-step srt-led" style={step(.68, .8)}>Webhook</span><span>Forward</span>
    </div>
  </div>,
  // A press: one letter in, a thousand out, and what that costs.
  campaign: <div className="srt-a" aria-hidden="true">
    <div className="srt-screen srt-v-campaign">
      <div className="srt-v-head"><b>We label the sausages by mood now</b></div>
      <p className="srt-sub">Counter Six Butcher to <b>Regulars</b>, 1,000 contacts</p>
      <div className="srt-grid">{Array.from({ length: 100 }, (_, i) => <i key={i} className="srt-step" style={step(.08 + (i % 20) * .028 + Math.floor(i / 20) * .012, .14 + (i % 20) * .028 + Math.floor(i / 20) * .012)} />)}</div>
      <div className="srt-meter"><span className="srt-step srt-fill" style={step(.08, .72)} /></div>
      <p className="srt-total"><span className="srt-step srt-in" style={step(.74, .86)}>1,000 sent</span><b className="srt-step srt-in" style={step(.84, .96)}>$0.20</b></p>
    </div>
    <span className="srt-roller" /><span className="srt-shelf" />
    <div className="srt-out">{[0, 1, 2, 3, 4, 5, 6, 7].map(i => <i key={i} className="srt-step" style={step(.14 + i * .075, .2 + i * .075)} />)}</div>
  </div>,
  // A thread: the message that came, and the reply from the same address.
  thread: <div className="srt-a" aria-hidden="true">
    <div className="srt-screen srt-v-thread">
      <div className="srt-v-head"><b>Re: can you send me the file again</b></div>
      <p className="srt-bubble">Here it is. Again.</p>
      <p className="srt-bubble srt-theirs srt-step srt-in" style={step(.08, .3)}><b>Zahir Bhatt</b>This is the fifth time. Each version is a different version.</p>
      <p className="srt-bubble srt-step srt-type" style={step(.42, .74)}>Sending version six. It is the last one.</p>
      <p className="srt-sent srt-step srt-in" style={step(.8, .94)}>Sent from the address it came to</p>
    </div>
    <span className="srt-reel" /><span className="srt-reel srt-reel-b" /><span className="srt-tape" />
  </div>,
  // A ledger printer: every message that went through, on tape, the newest at the head.
  logs: <div className="srt-a" aria-hidden="true">
    <div className="srt-feed srt-feed-down"><div className="srt-paper srt-step" style={step(0, .94)}>
      {LOGS.slice().reverse().map(([status, subject], i) => <p key={i} className="srt-log"><span data-status={status}>{status}</span><b>{subject}</b></p>)}
    </div></div>
    <div className="srt-keys srt-counter"><b>Logs</b><span>Sent and received</span></div>
  </div>,
}
