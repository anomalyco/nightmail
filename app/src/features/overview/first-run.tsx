import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Bot, Globe, Send, X } from 'lucide-react'
import { Button, ErrorText, IconButton, useToast } from '../../components/ui'
import { useApiDef, useSession, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { resourceOf } from '../../data/invalidation'
import { errorText, type SenderScore } from '../../data/types'
import { openConnectAgent, useConnectAgentOpen } from '../../lib/connect-agent'
import { number } from '../../lib/format'
import { matches, usePhone } from '../../lib/media'
import { useTestSend } from '../docs/first-send'
import type { SetupRead } from './setup'
import './first-run.css'

// Overview's get-started strip (no visible heading: the steps say it), for a new hosted workspace's owners and admins: three steps that tick off from the
// workspace's own state (GET /v1/overview/setup and /v1/me), never from clicks here: Send your first email (any email,
// the test included), Add your domain (one of its own verified) and Connect your agent (a key an agent's setup made, or
// a member's MCP sign-in here). Each step has one action: the test email to yourself, Domains' add form, the Connect
// your agent dialog. The strip leaves once all three are done (after a beat that says so) or when dismissed, and never
// comes back for that workspace: this browser remembers it.
//
// Who gets it: a workspace still new when Overview first sees it here, one without a sender grade yet that has sent to
// fewer than FRESH_RECIPIENTS real recipients (only tests, at most), with something left to do. One with a daily limit
// of none in /v1/me is graded (or exempt) and never asks. Once this browser has shown the strip for a workspace it keeps
// it until it is done or dismissed, however much mail goes meanwhile.
//
// Layout: the strip has one fixed height per width (first-run.css, STRIP_SPACE), known from the first frame it is: from
// this browser's memory (the route skeleton reserves it too), else once the setup read and the score land, which
// Overview's main column waits for. Leaving, the strip fades and what was under it slides up into its place by transform
// alone, so nothing shifts (useStripExit).

export type StepKey = 'send' | 'domain' | 'agent'
type Stored = 'on' | 'done' | 'dismissed' | 'off'
/** Real recipients (the sender score's count) under which a workspace with no grade is still new. */
const FRESH_RECIPIENTS = 25
/** What the strip takes above the figures on a desktop: its fixed height (first-run.css: 80px and a control, 44px on a
 *  touch screen) and its .ov-lead row's 4 + 12px padding. */
export const stripSpace = () => 80 + (matches('(pointer: coarse)') ? 44 : 28) + 16

const storeKey = (workspaceId: string) => `nightmail.overview.start.${workspaceId}`
const memory = new Map<string, Stored | null>(), listeners = new Set<() => void>()
function read(workspaceId: string): Stored | null {
  if (memory.has(workspaceId)) return memory.get(workspaceId)!
  try { const value = localStorage.getItem(storeKey(workspaceId)); return value === 'on' || value === 'done' || value === 'dismissed' || value === 'off' ? value : null } catch { return null }
}
function write(workspaceId: string, value: Stored) {
  if (read(workspaceId) === value) return
  try { localStorage.setItem(storeKey(workspaceId), value) } catch { /* Remembered for this page only. */ }
  memory.set(workspaceId, value)
  listeners.forEach(listener => listener())
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const useStored = (workspaceId: string) => useSyncExternalStore(subscribe, () => workspaceId ? read(workspaceId) : null)

/** Whether this browser may show the strip at all for the session's workspace: a hosted owner or admin whose sending is ready. */
function useEligible() {
  const identity = useSession()?.identity, { multiTenant, canAdminister } = useWorkspaceAccess(), connection = identity?.connection
  const workspaceId = identity?.workspaceId ?? ''
  const eligible = multiTenant && canAdminister && !!workspaceId && connection?.state === 'ready' && (!!connection.builtinDomain || (connection.domains?.verified ?? 0) > 0)
  return { eligible, workspaceId, connection }
}
/** The route skeleton's question, from this browser alone: is the strip already showing for this workspace? */
export function useStripRemembered() {
  const { eligible, workspaceId } = useEligible()
  return useStored(workspaceId) === 'on' && eligible
}

export type FirstRun = {
  /** The strip shows: its space is taken from the first frame this is known. */
  show: boolean
  /** Whether the strip shows, or its steps, isn't known yet: Overview's main column holds until it is. */
  pending: boolean
  done: Record<StepKey, boolean> | null
  /** Nothing sent or received yet. */
  empty: boolean
  workspaceId: string
}

export function useFirstRun(setup: SetupRead, score: { data?: SenderScore; isError: boolean }, sentHere: boolean): FirstRun {
  const { eligible, workspaceId, connection } = useEligible()
  const stored = useStored(workspaceId)
  const done = setup.loading || setup.error ? null : {
    send: !!setup.sent || !!connection?.sent || sentHere,
    domain: !!setup.ownVerified || (connection?.domains?.verified ?? 0) > 0,
    agent: setup.agent === true,
  }
  const all = !!done && done.send && done.domain && done.agent
  const empty = !!done && !done.send && !connection?.received
  // A daily limit of none is good standing (or an exemption): only a graded workspace has it.
  const established = connection?.sendingLimit?.cap === null
  const decided: Stored | null = !eligible || stored === 'done' || stored === 'dismissed' || stored === 'off' || setup.error ? 'off'
    : stored === 'on' ? 'on'
    : established ? 'off'
    : !done || (!score.data && !score.isError) ? null
    : score.data && score.data.state === 'warmup' && score.data.emails.firstEmails < FRESH_RECIPIENTS && !all ? 'on' : 'off'
  // Remembered once the score and setup decided it (not when a read failed: the next visit asks again).
  const remember = eligible && stored === null && decided !== null && !established && !score.isError && !setup.error ? decided : null
  useEffect(() => { if (remember) write(workspaceId, remember) }, [remember, workspaceId])
  // Once this visit has shown the page without the strip (a read that failed, the session filling in), it stays without
  // it until the next visit: a strip arriving over shown content would push it down.
  const without = useRef(false)
  if (decided === 'off' || (decided === 'on' && without.current)) { without.current = true; return { show: false, pending: false, done, empty, workspaceId } }
  if (decided === null) return { show: false, pending: true, done, empty, workspaceId }
  return { show: true, pending: !done, done, empty, workspaceId }
}

// Leaving: the strip's row is taken out, and in the same frame everything after it is moved back down by that row's
// height and slides up to rest (transform only, so the browser records no layout shift). Reduced motion: no travel,
// a short fade of what moves instead.
// The workspace remembers how it ended only after that frame, so its row never goes without the move.
export function useStripExit(workspaceId: string) {
  const [gone, setGone] = useState<'done' | 'dismissed' | null>(null)
  const moving = useRef<{ nodes: Element[]; height: number } | null>(null)
  const leave = (row: HTMLElement, how: 'done' | 'dismissed') => {
    const nodes: Element[] = []
    for (let node = row.nextElementSibling; node; node = node.nextElementSibling) nodes.push(node)
    moving.current = { nodes, height: row.getBoundingClientRect().height }
    setGone(how)
  }
  useEffect(() => { if (gone) write(workspaceId, gone) }, [gone, workspaceId])
  useLayoutEffect(() => {
    const move = moving.current
    if (!gone || !move) return
    moving.current = null
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches, from = `translateY(${move.height}px)`
    for (const node of move.nodes) node.animate(reduced
      ? [{ transform: from, opacity: 1 }, { transform: from, opacity: 0, offset: .45 }, { transform: 'none', opacity: 0, offset: .5 }, { transform: 'none', opacity: 1 }]
      : [{ transform: from }, { transform: 'none' }], { duration: reduced ? 240 : 420, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' })
  }, [gone])
  return { gone: gone !== null, leave }
}

const titles: Record<StepKey, string> = { send: 'Send your first email', domain: 'Add your domain', agent: 'Connect your agent' }
const order: StepKey[] = ['send', 'domain', 'agent']
const spring = 'cubic-bezier(0.23, 1, 0.32, 1)'

/**
 * The strip. `done` null: the steps aren't known yet (the page holds its main column meanwhile), so the marks are their
 * numbers and no step offers its action. `onSent`: a test went from here (the page reads its figures and list again).
 * `onLeave`: the strip has faded out; the page takes its row away (useStripExit).
 */
export function FirstRunStrip({ setup, done, onSent, onLeave }: { setup: SetupRead; done: Record<StepKey, boolean> | null; onSent: () => void; onLeave: (how: 'done' | 'dismissed') => void }) {
  const identity = useSession()?.identity, builtin = identity?.connection?.builtinDomain, to = identity?.email
  const strip = useRef<HTMLElement>(null)
  // The test email to yourself (POST /v1/domains/{id}/test-send) from the domain that sends. Sent, everything that counts
  // mail reads again, and the step ticks from the server's answer; a failure says why in the step's line.
  const client = useQueryClient(), phone = usePhone(), toast = useToast()
  const test = useTestSend(setup.sendFrom, () => {
    void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && ['overview', 'overview-setup', 'logs', 'emails', 'sender-score', 'sending-limit'].includes(resourceOf(query.queryKey)) }).catch(() => {})
    onSent()
  })
  // A phone's row has no line for it: the failure is a notice.
  useEffect(() => { if (test.error && phone) toast(errorText(test.error), 'error') }, [test.error]) // eslint-disable-line react-hooks/exhaustive-deps
  // While a step waits, the setup is read again every 10 s (an agent connecting, a domain verifying), and at once when
  // the Connect your agent dialog closes.
  const waiting = !!done && !(done.send && done.domain && done.agent)
  useApiDef(queries.overviewSetup(), { interval: waiting ? 10_000 : undefined })
  // A domain of its own verifying ends the built-in domain's cap: once the setup read has it and /v1/me doesn't yet, the
  // session (and the daily limit beside the strip) is read again.
  const behind = !!done?.domain && !identity?.connection?.domains?.verified
  useEffect(() => {
    if (behind) void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'identity' || (query.queryKey[0] === 'nightmail' && query.queryKey[1] === 'sending-limit') }).catch(() => {})
  }, [behind]) // eslint-disable-line react-hooks/exhaustive-deps
  // Coming back to Overview (a domain verified meanwhile, an agent connected from a terminal), what it read a while ago is read again.
  useEffect(() => {
    const read = client.getQueryState(['nightmail', 'overview-setup'])
    if (read && Date.now() - read.dataUpdatedAt > 1500) void client.invalidateQueries({ queryKey: ['nightmail', 'overview-setup'] }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useRecheckOnConnectClose(() => void client.invalidateQueries({ queryKey: ['nightmail', 'overview-setup'] }).catch(() => {}))
  // Transitions start once the steps have been drawn known: whatever is done when they first show is already at rest.
  const [live, setLive] = useState(false)
  useEffect(() => { if (!done || live) return; const frame = requestAnimationFrame(() => setLive(true)); return () => cancelAnimationFrame(frame) }, [done, live])
  const count = done ? order.filter(key => done[key]).length : 0, all = count === order.length
  const next = done ? order.find(key => !done[key]) : undefined

  // Leaving: a fade with a slight settle (or only the fade with reduced motion), then the page closes the row.
  const leaving = useRef(false)
  const exit = (how: 'done' | 'dismissed') => {
    if (leaving.current || !strip.current) return
    leaving.current = true
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const fade = strip.current.animate(reduced ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: 'scale(.98)', filter: 'blur(3px)' }], { duration: reduced ? 160 : 220, easing: spring, fill: 'forwards' })
    void fade.finished.then(() => onLeave(how), () => onLeave(how))
  }
  // All three done: the marks say so for a beat, then the strip goes, not while the pointer rests on it.
  const hovering = useRef(false), due = useRef(false)
  useEffect(() => {
    if (!all) return
    const timer = setTimeout(() => { due.current = true; if (!hovering.current) exit('done') }, live ? 1500 : 1800)
    return () => clearTimeout(timer)
  }, [all]) // eslint-disable-line react-hooks/exhaustive-deps

  return <section ref={strip} className="ov-start" aria-labelledby="ov-start-title" data-live={live || undefined} data-all={all || undefined}
    onPointerEnter={() => { hovering.current = true }} onPointerLeave={() => { hovering.current = false; if (due.current) exit('done') }}>
    <h2 id="ov-start-title" className="sr-only">{all ? 'You’re set up' : `Get started: ${count} of ${order.length} done`}</h2>
    <IconButton className="ov-start__dismiss" label="Dismiss" onClick={() => exit('dismissed')} data-analytics="overview/start/dismiss"><X size={16} aria-hidden /></IconButton>
    <ol className="ov-start__steps">
      <Step index={0} title={titles.send} done={done?.send} known={!!done} live={live}
        line={test.error ? <span className="ov-step__error"><ErrorText error={test.error} /></span> : !setup.sendFrom ? builtin?.paused ? 'Built-in domains are paused for now.' : 'Ready in a moment.' : `A test to your own address, from ${setup.sendFrom.builtIn ? 'the built-in domain' : setup.sendFrom.name}.`}
        doneLine={<>Sent. <Link to={test.data ? `/logs/${encodeURIComponent(test.data.id)}` : '/logs?view=sent'}>View in Logs</Link></>}
        action={done && <Button variant={next === 'send' ? 'primary' : 'secondary'} size="sm" className="ov-start__action" loading={test.isPending} disabled={!setup.sendFrom || !to || test.isSuccess} onClick={() => test.mutate()} data-analytics="overview/start/test"><Send size={14} aria-hidden />Send a test email</Button>} />
      <Step index={1} title={titles.domain} done={done?.domain} known={!!done} live={live}
        line={setup.pendingDomain ? <>Waiting for the DNS records of {setup.pendingDomain.name}.</> : null}
        doneLine={setup.ownVerified ? `${setup.ownVerified.name} is verified.` : 'Verified.'}
        action={done && <Link className={`ui-button ui-button--${next === 'domain' ? 'primary' : 'secondary'} ui-button--sm ov-start__action`} to={setup.pendingDomain ? `/domains/${setup.pendingDomain.id}` : '/domains?add'} data-analytics="overview/start/domain"><Globe size={14} aria-hidden />{setup.pendingDomain ? 'View records' : 'Add domain'}</Link>} />
      <Step index={2} title={titles.agent} done={done?.agent} known={!!done} live={live}
        line="Your coding agent gets its own key."
        doneLine="Connected."
        action={done && <Button variant={next === 'agent' ? 'primary' : 'secondary'} size="sm" className="ov-start__action" onClick={openConnectAgent} data-analytics="overview/start/agent"><Bot size={14} aria-hidden />Connect</Button>} />
    </ol>
  </section>
}

// One step: its mark (the number, then a drawn check), its title, a line that becomes what got done, and its action,
// which fades out once done. Every part keeps its place, so ticking moves nothing.
function Step({ index, title, done = false, known, live = false, line, doneLine, action }: { index: number; title: string; done?: boolean; known: boolean; live?: boolean; line: ReactNode; doneLine: ReactNode; action: ReactNode }) {
  // Ticking while in view, the dot gives one small pop as it fills.
  const mark = useRef<HTMLSpanElement>(null), was = useRef(done)
  useEffect(() => {
    if (done && !was.current && live && !matchMedia('(prefers-reduced-motion: reduce)').matches) mark.current?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)', offset: .35 }, { transform: 'scale(1)' }], { duration: 420, easing: spring })
    was.current = done
  }, [done, live])
  return <li className="ov-step" data-done={done || undefined} data-known={known || undefined} style={{ '--i': index } as CSSProperties}>
    <span ref={mark} className="ov-step__mark" aria-hidden="true"><span>{index + 1}</span><svg viewBox="0 0 12 12"><path d="M2.5 6.3 5 8.7 9.5 3.6" pathLength="1" /></svg></span>
    <span className="ov-step__title">{title}{done && <span className="sr-only"> (done)</span>}</span>
    <span className="ov-step__line"><span data-active={!done || undefined} aria-hidden={done || undefined}>{known ? line : null}</span><span data-active={done || undefined} aria-hidden={!done || undefined}>{done ? doneLine : null}</span></span>
    <span className="ov-step__do" inert={done || !known || undefined}>{action}</span>
  </li>
}

/** The route skeleton's strip, for a workspace this browser already shows it for: the same box, its steps not yet known. */
export function FirstRunSkeleton() {
  return <section className="ov-start" aria-hidden="true">
    <ol className="ov-start__steps">{order.map((key, index) => <Step key={key} index={index} title={titles[key]} known={false} line={null} doneLine={null} action={null} />)}</ol>
  </section>
}

/** Reads the setup again when the Connect your agent dialog closes, so a just-connected agent ticks at once. */
export function useRecheckOnConnectClose(recheck: () => void) {
  const open = useConnectAgentOpen(), was = useRef(open)
  useEffect(() => { if (was.current && !open) recheck(); was.current = open }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
}
