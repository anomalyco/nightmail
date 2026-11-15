import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { ArrowRight, LoaderCircle } from 'lucide-react'
import { Link } from 'react-router'
import { PrivateAddress } from '../../components/PrivateAddress'
import { SignInConsent } from '../../components/LegalLinks'
import { reducedMotion, type HomeProps } from '.'
import { DX, DY, type Plan } from './sorter/plan'

// Below the machine its eight tubes run on down the page, four each side, and one by one turn in to a unit standing on
// the floor: the places mail can go. Scrolling carries a capsule down each tube to its unit, where the letter in it
// arrives the way it does in the product: a row in the Inbox, a message in a mail app, an agent's turn, a ritual
// running, a webhook's payload, a campaign going out, a thread growing, a line in the logs. Everything is driven by
// how far the page has scrolled (--q on each unit, 0 to 1), with transforms, opacity and clipping only, so nothing
// shifts; with reduced motion every unit shows its finished state. The letters are from the sorter's own set.
type Station = { key: string; tube: number; side: 'l' | 'r'; name: string; line: string; plate: string }
const STATIONS: Station[] = [
  { key: 'inbox', tube: 3, side: 'l', name: 'Inbox', line: 'Every address keeps its own threads.', plate: 'Inbox' },
  { key: 'imap', tube: 4, side: 'r', name: 'IMAP and SMTP', line: 'Or open the same inbox in a mail app.', plate: 'IMAP' },
  { key: 'agent', tube: 2, side: 'l', name: 'Agent inboxes', line: 'Addresses your agents read and answer over MCP.', plate: 'Agents' },
  { key: 'ritual', tube: 5, side: 'r', name: 'Rituals', line: 'Short scripts that run on mail as it arrives.', plate: 'Rituals' },
  { key: 'endpoint', tube: 1, side: 'l', name: 'Endpoints', line: 'Slack, Discord, a webhook or a forward.', plate: 'Endpoints' },
  { key: 'campaign', tube: 6, side: 'r', name: 'Campaigns', line: 'One send to a whole audience, at the same price.', plate: 'Campaigns' },
  { key: 'thread', tube: 0, side: 'l', name: 'Threads', line: 'Reply from the address the mail came to.', plate: 'Threads' },
  { key: 'logs', tube: 7, side: 'r', name: 'Logs', line: 'And every message, sent or received, is on record.', plate: 'Logs' },
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
        // 0 as the unit's port comes in at the bottom of the window, 1 once it stands at 46% of its height.
        const q = Math.round(Math.min(1, Math.max(0, (view * 1.02 - box.top) / (view * .56))) * 500) / 500
        if (q !== last[i]) { last[i] = q; unit.style.setProperty('--q', String(q)) }
      })
    }
    const queue = () => { frame ||= requestAnimationFrame(measure) }
    measure()
    window.addEventListener('scroll', queue, { passive: true }); window.addEventListener('resize', queue)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', queue); window.removeEventListener('resize', queue) }
  }, [p])

  if (!p) return <section className="srt-stations" ref={root} aria-label="Where mail goes" />
  const phone = p.phone, r = p.tubeR, zt = -(r + 1.5 * p.U / 9)
  const pipeX = p.tubes.map(x => p.ox + x + DX * zt)
  // Each unit is a box on the floor in the machine's own projection: a front, and its top and side behind it.
  // The units stand in one column between the two fours of tubes; where the page is wide enough each one's name is
  // set outside the tubes, on the side its own tube does not come from.
  const gap = pipeX[4] - pipeX[3] - 2 * r, stack = p.W < 1140, w = Math.round(Math.min(520, gap - (phone ? 26 : 64)))
  const box = phone ? { w, h: 228, d: 44 } : { w, h: Math.round(w * .63), d: 64 }
  const pitch = box.h + (stack ? 250 : 190), lead = stack ? 150 : 120, port = stack ? 190 : Math.round(box.h / 2)
  const height = lead + STATIONS.length * pitch + 230
  const vars = { '--srt-r': `${r}px`, '--srt-box-w': `${box.w}px`, '--srt-box-h': `${box.h}px`, '--srt-dx': `${-DX * box.d}px`, '--srt-dy': `${DY * box.d}px`, height } as CSSProperties
  return <section className="srt-stations" ref={root} style={vars} aria-label="Where mail goes">
    {/* Where the machine's tubes come down onto this part of the floor: a clamp across each four. */}
    {[0, 4].map(first => <span key={first} className="srt-clamp" style={{ left: pipeX[first] - r - 5, width: pipeX[first + 3] - pipeX[first] + 2 * r + 9 }} aria-hidden="true" />)}
    {STATIONS.map((station, k) => {
      const top = lead + k * pitch, left = station.side === 'l', x = pipeX[station.tube]
      const boxLeft = Math.round(p.ox + (pipeX[3] + pipeX[4]) / 2 - p.ox - box.w / 2 - DX * box.d / 2)
      const reach = left ? boxLeft - x : x - (boxLeft + box.w), fall = Math.min(top + port, 330)
      return <div key={station.key} className="srt-unit" data-side={station.side} data-stack={stack || undefined} style={{ top, '--srt-port': `${port}px` } as CSSProperties}>
        {/* The tube: down the page to this unit's port, then in. A capsule rides it. */}
        <span className="srt-pipe" style={{ left: x - r, top: -top, height: top + port }} aria-hidden="true" />
        <span className="srt-pipe srt-pipe-in" style={{ left: left ? x : boxLeft + box.w, top: port, width: reach }} aria-hidden="true" />
        <span className="srt-joint" style={{ left: x, top: port }} aria-hidden="true" />
        <span className="srt-capsule" style={{ left: x - r * .075, top: port, '--fall': `${fall}px`, '--reach': `${left ? reach : -reach}px`, '--turn': fall / (fall + reach) } as CSSProperties} aria-hidden="true" />
        <div className="srt-box" style={{ left: boxLeft }}>
          <span className="srt-collar" aria-hidden="true" />
          <div className="srt-screen" aria-hidden="true">{VIGNETTES[station.key]}</div>
          <span className="srt-plate" aria-hidden="true">{station.plate}</span>
          <span className="srt-lamp" aria-hidden="true" />
        </div>
        <div className="srt-caption" style={stack ? { left: boxLeft, width: box.w } : left ? { left: pipeX[7] + r + 44 } : { right: p.W - pipeX[0] + r + 44 }}>
          <h2>{station.name}</h2>
          <p>{station.line}</p>
        </div>
      </div>
    })}
    <footer className="srt-end">
      <p className="srt-end-price"><b>$0.20</b> per 1,000 emails, sent or received.</p>
      <button type="button" className="srt-cta srt-end-cta" disabled={busy} aria-busy={busy || undefined} onClick={onSignIn} onPointerDown={onSignInIntent}>
        <span className="srt-cta-label">Get started{busy ? <LoaderCircle className="ui-spinner" size={16} aria-hidden="true" /> : <ArrowRight className="srt-cta-arrow" size={16} strokeWidth={2} aria-hidden="true" />}</span>
      </button>
      <SignInConsent className="srt-end-consent" />
      <nav aria-label="Site links"><a href="/docs">API docs</a><Link to="/legal/terms">Terms</Link><Link to="/legal/privacy">Privacy</Link></nav>
    </footer>
  </section>
}

const Row = ({ from, subject, when, fresh, style }: { from: string; subject: string; when: string; fresh?: boolean; style?: CSSProperties }) =>
  <div className={fresh ? 'srt-row-mail srt-step srt-fresh' : 'srt-row-mail'} style={style}><i className="srt-dot" /><b>{from}</b><span>{subject}</span><time>{when}</time></div>

const VIGNETTES: Record<string, ReactNode> = {
  // A new row at the top of the Inbox, unread.
  inbox: <div className="srt-v srt-v-inbox">
    <div className="srt-v-head"><b>Inbox</b><span className="srt-step srt-count" style={step(.1, .3)}><i>2</i><i>3</i></span></div>
    <div className="srt-list">
      <Row fresh from="On-Call Pager" subject="Your pager wants to be friends" when="now" style={step(.05, .4)} />
      <div className="srt-step srt-shift" style={step(.05, .4)}>
        <Row from="Handle Concern" subject="Order confirmed: 6 mugs, 7 handles" when="02:14" />
        <Row from="Nadia Sorrel" subject="Your badge photo is now the wrong you" when="01:40" />
        <Row from="nightly-sync" subject="Your cron job is asking about the point" when="00:03" />
      </div>
    </div>
  </div>,
  // The same inbox in a mail app: the count on the folder, the message in the list.
  imap: <div className="srt-v srt-v-imap">
    <div className="srt-app-side"><i /><i /><i /><span className="srt-folder">Inbox<b className="srt-step srt-pop" style={step(.2, .45)}>1</b></span><span>Sent</span><span>Junk</span><span>Archive</span></div>
    <div className="srt-app-list">
      <div className="srt-app-mail srt-step srt-fresh" style={step(.1, .5)}><b>Pantry Assistant</b><span>Your fridge has written a short essay</span><em>Title: On Being Opened. Twelve pages. Tone: considered, angry.</em></div>
      <div className="srt-app-mail"><b>Mill Row Bakes</b><span>The ovens are taking a vacation</span><em>Three days off. They earned it, we earned it. Bread Tuesday.</em></div>
      <div className="srt-app-mail"><b>Seed Library</b><span>New hours for the seed library</span><em>Open Tuesdays. Closed when we are in the garden.</em></div>
    </div>
  </div>,
  // An agent waits on its inbox, reads what arrives, replies.
  agent: <div className="srt-v srt-v-agent">
    <p className="srt-step srt-type" style={step(0, .16)}><i>agent</i> inboxes.wait()</p>
    <p className="srt-step srt-in srt-got" style={step(.2, .36)}><i>mail</i> <b>Bertram Quaife</b> Turn a one-star canteen review into notes</p>
    <p className="srt-step srt-in srt-quote" style={step(.34, .5)}>Extract the actionable part from 'the soup was a warning'.</p>
    <p className="srt-step srt-type" style={step(.54, .78)}><i>agent</i> messages.reply("1. Label the soup.")</p>
    <p className="srt-step srt-in srt-ok" style={step(.82, .96)}><i>mail</i> Reply sent from the inbox's address</p>
  </div>,
  // A ritual runs on the message: the condition holds, two actions follow.
  ritual: <div className="srt-v srt-v-ritual">
    <pre><span>export default function route(email) {'{'}</span>
      <span className="srt-step srt-run" style={step(.1, .3)}>  if (email.subject.includes("pager")) {'{'}<b className="srt-step srt-pop" style={step(.3, .42)}>true</b></span>
      <span className="srt-step srt-run" style={step(.42, .58)}>    label("on-call")</span>
      <span className="srt-step srt-run" style={step(.58, .76)}>    endpoints.pager({'{'} text: email.subject {'}'})</span>
      <span>  {'}'}</span>
      <span>{'}'}</span></pre>
    <div className="srt-chips"><span className="srt-step srt-in" style={step(.5, .64)}>Labelled on-call</span><span className="srt-step srt-in" style={step(.72, .88)}>Sent to pager</span></div>
  </div>,
  // The payload a webhook endpoint is sent, and its answer.
  endpoint: <div className="srt-v srt-v-endpoint">
    <p className="srt-step srt-type" style={step(0, .2)}><b>POST</b> https://hooks.acme.example/mail</p>
    <pre className="srt-step srt-unfold" style={step(.2, .7)}>{'{\n  "type": "message.received",\n  "from": '}<PrivateAddress value="deliver@hooks.example" />{',\n  "subject": "Your webhook is answering in Latin",\n  "text": "Status 200, but the body is a mood…"\n}'}</pre>
    <p className="srt-step srt-in srt-ok" style={step(.76, .92)}><b>200</b> OK</p>
  </div>,
  // A campaign goes out to an audience: a thousand contacts, and what that costs.
  campaign: <div className="srt-v srt-v-campaign">
    <div className="srt-v-head"><b>We label the sausages by mood now</b></div>
    <p className="srt-sub">Counter Six Butcher to <b>Regulars</b>, 1,000 contacts</p>
    <div className="srt-grid">{Array.from({ length: 100 }, (_, i) => <i key={i} className="srt-step" style={step(.08 + (i % 20) * .028 + Math.floor(i / 20) * .012, .14 + (i % 20) * .028 + Math.floor(i / 20) * .012)} />)}</div>
    <div className="srt-meter"><span className="srt-step srt-fill" style={step(.08, .72)} /></div>
    <p className="srt-total"><span className="srt-step srt-in" style={step(.74, .86)}>1,000 sent</span><b className="srt-step srt-in" style={step(.84, .96)}>$0.20</b></p>
  </div>,
  // A thread: the message that came, and the reply from the same address.
  thread: <div className="srt-v srt-v-thread">
    <div className="srt-v-head"><b>Re: can you send me the file again</b></div>
    <p className="srt-bubble">Here it is. Again.</p>
    <p className="srt-bubble srt-theirs srt-step srt-in" style={step(.08, .3)}><b>Zahir Bhatt</b>This is the fifth time. Each version is a different version.</p>
    <p className="srt-bubble srt-step srt-type" style={step(.42, .74)}>Sending version six. It is the last one.</p>
    <p className="srt-sent srt-step srt-in" style={step(.8, .94)}>Sent from <PrivateAddress value="files@acme.example" /></p>
  </div>,
  // The logs: every message that went through, newest first.
  logs: <div className="srt-v srt-v-logs">
    <div className="srt-v-head"><b>Logs</b><span>Sent and received</span></div>
    {[['Received', 'Your pager wants to be friends', .7], ['Sent', 'Sending version six. It is the last one.', .56], ['Received', 'Re: can you send me the file again', .42], ['Delivered', 'We label the sausages by mood now', .28], ['Received', 'Your webhook is answering in Latin', .14], ['Received', 'Turn a one-star canteen review into notes', 0]].map(([status, subject, from], i) =>
      <div key={i} className="srt-log srt-step srt-in" style={step(from as number, (from as number) + .16)}><span data-status={status}>{status}</span><b>{subject}</b></div>)}
  </div>,
}
