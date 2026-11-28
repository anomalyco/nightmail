import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react'
import { Bot } from 'lucide-react'
import { Tooltip } from '../../components/ui'
import { useSession } from '../../data/context'
import { initials } from '../../data/accounts'
import { socketUrl } from '../../data/live'
import { useMediaQuery } from '../../lib/media'
import './presence.css'

// Who else has this campaign open, from its room (api/src/campaign-room.ts): people with its Write or Review page open,
// and agents that read or saved it in the last two minutes. One socket per page, which the room answers only when
// someone joins or leaves; alone, it is a hibernated connection and a ping every 30 s the runtime answers for it. People
// are known by a key the room gives them (never a user ID), and an agent's name only to those who see API keys.
type Person = { kind: 'person'; slot: number; id: string; name: string; view: 'write' | 'review' }
type Agent = { kind: 'agent'; id: string; name: string; at: number; ago?: number; saved?: number }
export type Present = { id: string; kind: 'person' | 'agent'; name: string; view?: Person['view']; color: number }
const AGENT_MS = 120_000, PING_MS = 30_000, READMIT = 4000, AGENT = 'An agent'
// Reconnecting: exponential, with jitter so a deploy doesn't bring every tab back in the same instant, at most 30 s apart,
// and after eight failures in a row it waits until the tab is shown again or comes back online.
const RETRY_MAX_MS = 30_000, RETRIES = 8
// A tab that leaves and comes straight back (Write to Review) stays on screen instead of blinking out.
const LEAVE_MS = 1500
/** A person's colour, the same in every browser, for their face, pointer and highlights. Flat, and white text reads on each. */
export const PRESENCE_COLORS = ['#d13f45', '#1f6fd1', '#23855a', '#8a4fc4', '#c43d8e', '#c25a12', '#0f7d8a', '#5d5fc9']
export const presenceColor = (id: string) => { let hash = 0; for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return hash % PRESENCE_COLORS.length }
/** Someone saved the draft (a person through their tab, an agent through the API), at this revision. */
export type Save = { revision: number; by: { kind: 'person' | 'agent'; id: string; name: string } }
/** The room: the people by slot (self: this person's key, for their other tabs) and binary frames each way
 *  (presence-overlay.tsx), and saves. announce tells everyone
 *  else (your other tabs too) that this page saved, so their pages read it now instead of at their next poll. */
export type Room = { people: ReadonlyMap<number, Present & { slot: number }>; self: string | null; send: (frame: Uint8Array<ArrayBuffer>) => void; listen: (receive: (frame: Uint8Array) => void) => () => void; joins: number; announce: (revision: number) => void; onSave: (receive: (save: Save) => void) => () => void }

// The open rooms by campaign, so whatever saves a campaign on this page (Write's autosave, Review's list) can say so.
const open = new Map<string, (revision: number) => void>()
/** Tell everyone else in the campaign's room that this page just saved it (no-op where no room is open). */
export const announceSave = (campaignId: string, revision: number | undefined) => { if (revision) open.get(campaignId)?.(revision) }

export function useCampaignPresence(campaignId: string | null | undefined, view: Person['view']): { present: Present[]; room: Room } {
  const identity = useSession()?.identity
  const enabled = Boolean(campaignId && identity?.presence)
  // By slot. A slot is reused once free, so a delayed leave removes only the person who left (the same object).
  const people = useRef(new Map<number, Person>()), [version, changed] = useReducer((n: number) => n + 1, 0)
  // This person's key in the room (hello's self): their other tabs are not someone else.
  const [self, setSelf] = useState<string | null>(null)
  const [agents, setAgents] = useState<ReadonlyMap<string, Agent>>(new Map())
  const [now, setNow] = useState(() => Date.now())
  const socket = useRef<WebSocket | null>(null), listeners = useRef(new Set<(frame: Uint8Array) => void>()), [joins, joined] = useReducer((n: number) => n + 1, 0)
  const saves = useRef(new Set<(save: Save) => void>())
  // The same functions for the page's whole life, so effects that use them don't start again on every change.
  const stable = useRef({
    listen: (receive: (frame: Uint8Array) => void) => { listeners.current.add(receive); return () => { listeners.current.delete(receive) } },
    onSave: (receive: (save: Save) => void) => { saves.current.add(receive); return () => { saves.current.delete(receive) } },
    // [5][revision: two big-endian u16], only when anyone else, or another tab of yours, is here.
    announce: (revision: number) => {
      const ws = socket.current
      if (ws?.readyState !== WebSocket.OPEN || !people.current.size) return
      ws.send(new Uint8Array([5, (revision >>> 24) & 255, (revision >>> 16) & 255, (revision >>> 8) & 255, revision & 255]))
    },
  })
  const saved = (save: Save) => { for (const receive of saves.current) receive(save) }
  useEffect(() => {
    if (!enabled || !campaignId) return
    let stopped = false, failures = 0, resting = false
    let retry: ReturnType<typeof setTimeout> | undefined, ping: ReturnType<typeof setInterval> | undefined
    const leaving = new Set<ReturnType<typeof setTimeout>>()
    const connect = () => {
      const ws = socket.current = new WebSocket(socketUrl(`/v1/campaigns/${encodeURIComponent(campaignId)}/room`, { view }))
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => { failures = 0; resting = false; ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping') }, PING_MS) }
      ws.onmessage = ({ data }) => {
        if (data instanceof ArrayBuffer) {
          const frame = new Uint8Array(data), person = people.current.get(frame[0]!)
          if (frame[1] === 5 && frame.length >= 6 && person) saved({ revision: ((frame[2]! << 24) | (frame[3]! << 16) | (frame[4]! << 8) | frame[5]!) >>> 0, by: { kind: 'person', id: person.id, name: person.name } })
          else for (const receive of listeners.current) receive(frame)
          return
        }
        if (typeof data !== 'string' || data === 'pong') return
        let message: { type?: string; self?: string; peers?: (Person | Agent)[]; peer?: Person | Agent; slot?: number }
        try { message = JSON.parse(data) } catch { return }
        const { peer } = message
        if (message.type === 'hello') {
          setSelf(message.self ?? null)
          people.current = new Map((message.peers ?? []).filter((item): item is Person => item.kind === 'person').map(item => [item.slot, item])); changed(); joined()
          setAgents(new Map((message.peers ?? []).filter((item): item is Agent => item.kind === 'agent').map(item => [item.id, { ...item, at: Date.now() - Math.max(0, item.ago ?? 0) }])))
        } else if (message.type === 'join' && peer?.kind === 'person') { people.current.set(peer.slot, peer); changed(); joined() }
        else if (message.type === 'agent' && peer?.kind === 'agent') {
          setAgents(map => new Map(map).set(peer.id, { ...peer, at: Date.now() })); setNow(Date.now())
          if (typeof peer.saved === 'number') saved({ revision: peer.saved, by: { kind: 'agent', id: peer.id, name: peer.name } })
        }
        else if (message.type === 'leave' && typeof message.slot === 'number') {
          const slot = message.slot, gone = people.current.get(slot)
          const timer = setTimeout(() => { leaving.delete(timer); if (gone && people.current.get(slot) === gone) { people.current.delete(slot); changed() } }, LEAVE_MS)
          leaving.add(timer)
        }
      }
      ws.onclose = ({ code }) => {
        clearInterval(ping)
        if (stopped) return
        // The admission ran out (the room asks every tab to join again now and then): straight back, faces kept.
        if (code === READMIT) { retry = setTimeout(connect, Math.random() * 300); return }
        people.current = new Map(); changed()
        if (failures >= RETRIES) { resting = true; return }
        retry = setTimeout(connect, Math.min(RETRY_MAX_MS, 1000 * 2 ** failures++) * (0.5 + Math.random() / 2))
      }
    }
    // After the retries ran out: try again when the tab is shown or the network returns.
    const wake = () => { if (resting && document.visibilityState === 'visible') { resting = false; failures = 0; connect() } }
    document.addEventListener('visibilitychange', wake); window.addEventListener('online', wake); window.addEventListener('focus', wake)
    connect()
    open.set(campaignId, stable.current.announce)
    return () => {
      if (open.get(campaignId) === stable.current.announce) open.delete(campaignId)
      stopped = true; clearTimeout(retry); clearInterval(ping); leaving.forEach(clearTimeout)
      document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); window.removeEventListener('focus', wake)
      socket.current?.close(1000); socket.current = null
      people.current = new Map(); changed(); setAgents(new Map())
    }
  }, [enabled, campaignId, view])
  // An agent drops out two minutes after its last read or save.
  useEffect(() => {
    const active = [...agents.values()].map(agent => agent.at + AGENT_MS).filter(until => until > now)
    if (!active.length) return
    const next = Math.min(...active)
    const timer = setTimeout(() => {
      const current = Date.now()
      setNow(current)
      setAgents(map => {
        let stale = false
        for (const agent of map.values()) if (current - agent.at >= AGENT_MS) { stale = true; break }
        if (!stale) return map
        const kept = new Map<string, Agent>()
        for (const [id, agent] of map) if (current - agent.at < AGENT_MS) kept.set(id, agent)
        return kept
      })
    }, Math.max(0, next - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [agents, now])
  // In the order they arrived, so a face that arrives goes at the end and none of the others moves.
  const arrival = useRef(new Map<string, number>()), next = useRef(0)
  return useMemo(() => {
    const byPerson = new Map<string, Present>()
    for (const person of people.current.values()) {
      if (person.id === self) continue
      const seen = byPerson.get(person.id)
      // One face per person, however many tabs; on Write if any of them is.
      if (!seen || person.view === 'write') byPerson.set(person.id, { id: person.id, kind: 'person', name: person.name, view: person.view, color: presenceColor(person.id) })
    }
    const present = [...agents.values()].filter(agent => now - agent.at < AGENT_MS).map(agent => ({ id: agent.id, kind: 'agent' as const, name: agent.name, color: 0 }))
    const all = [...byPerson.values(), ...present], here = new Set(all.map(item => item.kind + item.id))
    for (const key of arrival.current.keys()) if (!here.has(key)) arrival.current.delete(key)
    for (const key of here) if (!arrival.current.has(key)) arrival.current.set(key, next.current++)
    // Other people's tabs by slot (not your own other tabs), for the pointers and highlights.
    const slots = new Map([...people.current.values()].filter(person => person.id !== self).map(person => [person.slot, { id: person.id, kind: 'person' as const, name: person.name, view: person.view, color: presenceColor(person.id), slot: person.slot }]))
    const room: Room = { people: slots, self, joins, send: frame => { const ws = socket.current; if (ws?.readyState === WebSocket.OPEN && slots.size) ws.send(frame) }, ...stable.current }
    return { present: all.sort((a, b) => arrival.current.get(a.kind + a.id)! - arrival.current.get(b.kind + b.id)!), room }
  }, [version, agents, now, self, joins])
}

/** Faces of the people and agents also in this campaign: three and then a count on a wide screen. Where the bar is
 *  narrower (1,100 px and less, phones), one face that counts everyone else in its corner, in a place kept for it
 *  whenever the page has a room (room), so nobody arriving moves the bar. */
export function CampaignPresence({ present, room }: { present: Present[]; room: boolean }) {
  const compact = useMediaQuery('(max-width: 1100px)'), reserve = Boolean(useSession()?.identity?.presence && room && compact)
  // Wide: three places, each face keeping its own until it leaves; someone arriving takes the first free one (then a
  // count). A place freed between two faces stays empty, so nobody else moves; the outermost free ones close up.
  const places = useRef<(string | null)[]>([])
  const keys = present.map(item => item.kind + item.id)
  let kept = places.current.map(key => key && keys.includes(key) ? key : null)
  for (const key of keys) if (!kept.includes(key)) { const free = kept.indexOf(null); if (free !== -1) kept[free] = key; else if (kept.length < 3) kept.push(key) }
  while (kept.length && kept.at(-1) === null) kept = kept.slice(0, -1)
  places.current = kept
  if (!present.length) return reserve ? <div className="campaign-presence" data-reserve aria-hidden="true" /> : null
  const describe = (item: Present) => item.kind === 'agent' ? item.name === AGENT ? AGENT : `${item.name} · agent` : item.view === 'review' ? `${item.name} · on Review` : item.name
  const face = (item: Present, others = 0) => <Tooltip key={item.kind + item.id} content={others ? present.map(describe).join(', ') : describe(item)}>
    <span className="campaign-presence__face" data-kind={item.kind} style={item.kind === 'person' ? { '--presence-color': PRESENCE_COLORS[item.color] } as CSSProperties : undefined} aria-hidden="true">{item.kind === 'agent' ? <Bot size={14} strokeWidth={2.25} /> : initials(item.name)}{others > 0 && <span className="campaign-presence__count">+{others}</span>}</span>
  </Tooltip>
  const byKey = new Map(present.map(item => [item.kind + item.id, item])), rest = present.length - kept.filter(Boolean).length
  return <div className="campaign-presence" data-reserve={reserve || undefined} role="group" aria-label={`Also here: ${present.map(describe).join(', ')}`}>
    {compact ? face(present[0]!, present.length - 1) : <>
      {kept.map((key, place) => key ? face(byKey.get(key)!) : <span key={`place-${place}`} className="campaign-presence__face" data-empty aria-hidden="true" />)}
      {rest > 0 && <Tooltip content={present.filter(item => !kept.includes(item.kind + item.id)).map(describe).join(', ')}><span className="campaign-presence__face campaign-presence__more" aria-hidden="true">+{rest}</span></Tooltip>}
    </>}
  </div>
}
