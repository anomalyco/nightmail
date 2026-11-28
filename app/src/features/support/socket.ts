import type { RequestScope } from '../../data/live'
import { supportActionsApi, supportApi, type CurrentSupportConversation } from '../../data/support'
import { ApiError } from '../../data/types'
import { FileError, parseServerMessage, sniff, type ClientMessage, type Connection, type FiledTicket, type SupportTransport, type TransportEvent } from './protocol'
import { hostedHosts, productName, supportHost } from '../../../../api/src/brand'

// The live transport (support/PROTOCOL.md §1–2, §5): one continuous conversation per person and workspace.
// The server is the source of truth: on open without a cached socket URL, GET /v1/support-conversations/current checks
// for an open chat in this workspace and resumes it via /chat/resume; when none exists, the panel sits in 'ready' until
// the person sends a message or attaches a screenshot, at which point POST /chat/start { handoff, resume: true } creates
// or joins it. A lost connection retries with backoff and again as soon as the browser is back online.
type Started = { conversationId: string; chatToken: string; socketUrl: string; expiresAt: string }
class StartError extends Error { constructor(readonly status: number, readonly code: string, readonly retryAfter?: number) { super(code) } }

// What rejoins a conversation on reload without an extra round trip (PROTOCOL.md §1): its ID and the socket URL until
// its token expires. Keyed by user and workspace in sessionStorage; cleared on sign-out or account change.
type Saved = { conversationId: string; socketUrl?: string; expiresAt?: string }
const storageKey = (userId: string, workspaceId: string) => `bane.support.conversation.${userId}.${workspaceId}`
// `parked`: words not yet with the chat or filed (store.ts), sent on their own while the box still holds exactly them.
const draftKey = (mode: 'demo' | 'live', userId: string, workspaceId: string, slot: 'draft' | 'parked' = 'draft') => `bane.support.${slot}.${mode}.${userId}.${workspaceId}`
/** Forgets saved conversations and drafts: every account's (a sign-out), or only legacy slots from earlier releases. */
export function forgetSaved(all: boolean) {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (all && /^bane\.support\.(conversation|last|draft|parked)\./.test(key)) sessionStorage.removeItem(key)
      else if (!all && (/^bane\.support\.last\./.test(key) || (/^bane\.support\.conversation\./.test(key) && !/^bane\.support\.conversation\.[^.]+\.[^.]+$/.test(key)))) sessionStorage.removeItem(key)
    }
  } catch { /* Session-only. */ }
}
export function loadDraft(mode: 'demo' | 'live', userId: string, workspaceId: string, slot: 'draft' | 'parked' = 'draft'): string {
  try { return sessionStorage.getItem(draftKey(mode, userId, workspaceId, slot)) ?? '' } catch { return '' }
}
export function saveDraft(mode: 'demo' | 'live', userId: string, workspaceId: string, draft: string, slot: 'draft' | 'parked' = 'draft') {
  try {
    const key = draftKey(mode, userId, workspaceId, slot)
    if (draft) sessionStorage.setItem(key, draft)
    else sessionStorage.removeItem(key)
  } catch { /* Session-only. */ }
}
function load(key: string): Saved | null {
  let raw: string | null = null
  try { raw = sessionStorage.getItem(key) } catch { return null }
  if (!raw) return null
  let saved: Saved | null = null
  try { saved = JSON.parse(raw) as Saved } catch { /* Not ours: forgotten below. */ }
  if (typeof saved?.conversationId !== 'string') { save(key, null); return null }
  return saved
}
const save = (key: string, value: Saved | null) => { try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key) } catch { /* Session-only. */ } }
const fresh = (expiresAt?: string) => Boolean(expiresAt && Date.parse(expiresAt) - Date.now() > 60_000)

// A screenshot upload (§5.1) over XHR, which reports upload progress (fetch doesn't).
const UPLOAD_ERRORS: Record<string, string> = {
  TOO_MANY_ATTACHMENTS: 'Up to 5 screenshots per conversation.',
  CONVERSATION_CLOSED: 'This conversation has ended.',
  ATTACHMENT_TOO_LARGE: 'Screenshots can be up to 5 MB.',
  UNSUPPORTED_TYPE: 'Only PNG, JPEG or WebP images.',
  INVALID_IMAGE: 'The image is damaged or over 8,000 pixels on a side.',
}
function postImage(url: string, token: string, type: string, file: File, onProgress: (fraction: number) => void, signal: AbortSignal) {
  return new Promise<{ status: number; body: { attachment?: { id?: string }; error?: { code?: string } } | null }>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => { xhr.abort(); reject(new DOMException('The upload was cancelled.', 'AbortError')) }
    xhr.open('POST', url)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('Content-Type', type)
    if (file.name) xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name))
    // Held under 100% until the server has stored it.
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(.95, event.loaded / event.total)) }
    xhr.onload = () => { let body = null; try { body = JSON.parse(xhr.responseText) } catch { /* No JSON body. */ } resolve({ status: xhr.status, body }) }
    xhr.onerror = () => reject(new Error(`Couldn’t reach ${productName} support. Try again.`))
    xhr.onloadend = () => signal.removeEventListener('abort', abort)
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    xhr.send(file)
  })
}

async function post(origin: string, path: string, body: unknown): Promise<Started> {
  let response: Response
  try { response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
  catch { throw new StartError(0, 'NETWORK') }
  const data = await response.json().catch(() => null) as (Started & { error?: { code?: string; retryAfter?: number } }) | null
  if (!response.ok || !data?.socketUrl) throw new StartError(response.status, data?.error?.code ?? 'UNAVAILABLE', data?.error?.retryAfter)
  return data
}
/** How many conversations one open() tries before it gives up for now (each a stale one /chat/resume refused). */
const OPEN_TRIES = 4
const currentConversation = async (scope: RequestScope): Promise<CurrentSupportConversation | null> => {
  try { return (await supportApi(scope).current()).conversation }
  catch (error) { throw error instanceof ApiError && error.code !== 'NETWORK_UNAVAILABLE' ? new StartError(error.status ?? 400, error.code) : new StartError(0, 'NETWORK') }
}
// The handoff from Nightmail. No token means support signing isn't configured here; a refusal (not a lost network) is final too.
const handoff = async (scope: RequestScope, shareContent: boolean) => {
  let token: string | null
  try { ({ token } = await supportApi(scope).contact({ shareContent })) }
  catch (error) { throw error instanceof ApiError && error.code !== 'NETWORK_UNAVAILABLE' ? new StartError(error.status ?? 400, error.code) : new StartError(0, 'NETWORK') }
  if (!token) throw new StartError(503, 'NO_HANDOFF')
  return token
}

/** Files a message the chat can't take as a ticket for the team (POST /v1/contact-support with ticket): Nightmail's own
 *  API, so it works while the support Worker is down. 429 is the person's hourly limit; anything else is kept and retried. */
async function fileTicket(scope: RequestScope, text: string): Promise<FiledTicket> {
  try {
    const { ticket } = await supportApi(scope).contact({ shareContent: false, ticket: text })
    if (!ticket) throw new FileError('unreachable')
    return ticket
  } catch (error) {
    if (error instanceof FileError) throw error
    throw new FileError(error instanceof ApiError && error.status === 429 ? 'capped' : 'unreachable')
  }
}

export function createSocketTransport({ origin, userId, workspaceId, resume, scope }: { origin: string; userId: string; workspaceId: string; resume?: string | null; scope: RequestScope }): SupportTransport {
  const support = supportApi(scope), actions = supportActionsApi(scope)
  forgetSaved(false)
  const key = storageKey(userId, workspaceId)
  // ?support=<conversationId> (`resume`) opens that chat conversation directly; otherwise keep the workspace's conversation.
  if (resume) save(key, { conversationId: resume })
  const listeners = new Set<(event: TransportEvent) => void>()
  const emit = (event: TransportEvent) => { for (const listener of listeners) listener(event) }
  // After a reload, the saved socket URL reconnects directly while its token is still valid.
  const saved = load(key)
  let socket: WebSocket | null = null, state: Connection = 'idle'
  let started: Started | null = saved?.socketUrl && fresh(saved.expiresAt) ? { conversationId: saved.conversationId, chatToken: '', socketUrl: saved.socketUrl, expiresAt: saved.expiresAt! } : null
  let wantCreate = false, connecting: Promise<void> | null = null
  // A handoff not spent yet (its token lasts 10 minutes): retrying after the support service failed reuses it rather than
  // signing another, so an outage doesn't use up the person's handoffs for the hour (10, api/src/support.ts) and keep the
  // chat refused after the service is back.
  let unspent: { token: string; at: number } | null = null
  // The support Worker couldn't be reached last time: a new handoff (each counts against that same hourly limit, as every
  // filed ticket does) waits until it answers again, asked with a request that spends nothing (an empty resume: 400).
  let unreachable = false
  const answers = async () => {
    try { return (await fetch(`${origin}/chat/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status < 500 }
    catch { return false }
  }
  const nextHandoff = async () => {
    if (unspent && Date.now() - unspent.at < 8 * 60_000) return unspent.token
    if (unreachable && !await answers()) throw new StartError(0, 'NETWORK')
    const token = await handoff(scope, false)
    unspent = { token, at: Date.now() }
    return token
  }
  let attempt = 0, retry: ReturnType<typeof setTimeout> | undefined, ping: ReturnType<typeof setInterval> | undefined
  let disposed = false, generation = 0
  const setState = (next: Connection, extra: Omit<Extract<TransportEvent, { type: 'connection' }>, 'type' | 'state'> = {}) => { state = next; emit({ type: 'connection', state: next, ...extra }) }

  // Look up the workspace's open conversation from Nightmail (when none is cached locally), resume it if one exists,
  // or start one only when `wantCreate` is true (the person sent a message, attached a screenshot or asked for a person).
  // A conversation /chat/resume refused is never tried again in this open(), even when Nightmail still lists it as the
  // open one: it starts fresh instead (or stays ready), and a few tries in all bound the loop.
  async function open(): Promise<Started | null> {
    let conversationId = load(key)?.conversationId ?? null
    const refused = new Set<string>()
    for (let tries = 0; ; tries++) {
      try {
        if (!conversationId) {
          const found = await currentConversation(scope)
          conversationId = found?.id && !refused.has(found.id) ? found.id : null
          if (!conversationId && !wantCreate) return null
        }
        const token = await nextHandoff()
        const result = conversationId
          ? await post(origin, '/chat/resume', { conversationId, handoff: token })
          : await post(origin, '/chat/start', { handoff: token, resume: true })
        unspent = null
        return result
      } catch (error) {
        if (!(error instanceof StartError)) throw error
        // Stale or closed conversation, or an email conversation: forget it, then stay ready or start fresh if sending.
        if (conversationId && (error.status === 404 || error.code === 'EMAIL_CONVERSATION')) {
          refused.add(conversationId)
          save(key, null)
          conversationId = null
          if (!wantCreate) return null
          if (tries < OPEN_TRIES) continue
        }
        if (error.code === 'HANDOFF_INVALID' || error.code === 'HANDOFF_USED') unspent = null
        if (tries === 0 && (error.code === 'HANDOFF_INVALID' || error.code === 'HANDOFF_USED')) continue
        throw error
      }
    }
  }
  function schedule() {
    if (disposed) return
    const delay = Math.min(30_000, 1000 * 2 ** attempt++)
    setState('offline', { retryAt: Date.now() + delay })
    clearTimeout(retry)
    retry = setTimeout(() => { void connect() }, delay)
  }
  function teardown() {
    clearInterval(ping); ping = undefined
    if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; socket.close(1000); socket = null }
  }
  async function connect(options?: { create?: boolean }) {
    if (options?.create) wantCreate = true
    if (disposed || (state === 'open' && socket)) return
    if (state === 'connecting') { if (connecting) await connecting; return }
    clearTimeout(retry)
    const current = ++generation
    setState('connecting')
    teardown()
    const run = (async () => {
      let fromCache = false
      try {
        // A chat token that hasn't expired reconnects directly; otherwise check Nightmail and resume/start.
        if (started && fresh(started.expiresAt)) fromCache = true
        else {
          const result = await open()
          if (current !== generation || disposed) return
          if (!result) {
            if (wantCreate) { state = 'idle'; void connect({ create: true }); return }
            setState('ready')
            return
          }
          started = result
        }
      } catch (error) {
        if (current !== generation) return
        if (error instanceof StartError && error.code === 'RATE_LIMITED') { setState('unavailable', { reason: 'RATE_LIMITED', retryAt: Date.now() + (error.retryAfter ?? 60) * 1000 }); return }
        if (error instanceof StartError && (error.code === 'NO_HANDOFF' || error.status >= 400 && error.status < 500 && error.status !== 408)) { setState('unavailable', { reason: error.code }); return }
        unreachable = true
        schedule()
        return
      }
      if (current !== generation || disposed || !started) return
      save(key, { conversationId: started.conversationId, socketUrl: started.socketUrl, expiresAt: started.expiresAt })
      let opened = false
      const ws = socket = new WebSocket(started.socketUrl)
      ws.onopen = () => {
        opened = true; attempt = 0; unreachable = false
        setState('open')
        ping = setInterval(() => send({ type: 'ping' }), 30_000)
      }
      ws.onmessage = event => {
        const message = parseServerMessage(event.data)
        if (!message) return
        // GRANT_EXPIRED: account access ended; a fresh handoff renews it and the agent carries on.
        if (message.type === 'error' && message.code === 'GRANT_EXPIRED') { started = null; teardown(); state = 'idle'; void connect(); return }
        if (message.type === 'error' && message.code === 'BAD_MESSAGE') console.warn('[support] the server refused a message from the panel', message.message)
        if (message.type === 'closed' || message.type === 'hello' && message.status === 'closed') { save(key, null); wantCreate = false }
        emit({ type: 'server', message })
      }
      ws.onclose = event => {
        if (socket !== ws) return
        teardown()
        // 1000: the conversation ended (a closed message came first); nothing to reconnect to.
        if (opened && event.code === 1000) { setState('idle'); return }
        // Refused before opening (expired/revoked cached token or closed conversation), or closed for an expired token:
        // drop the cached socket and renew via open(). A refused cached socket retries immediately without flashing offline.
        if (!opened || event.code === 4401 || event.code === 1008) started = null
        state = 'idle'
        if ((opened && event.code === 4401) || (!opened && fromCache)) void connect()
        else schedule()
      }
    })()
    connecting = run
    try { await run } finally { if (connecting === run) connecting = null }
  }
  function send(message: ClientMessage) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }
  const online = () => { if (state === 'offline') { attempt = 0; void connect() } }
  window.addEventListener('online', online)
  return {
    kind: 'live',
    connect: options => { attempt = 0; void connect(options) },
    send,
    // Allow on a consent card (PROTOCOL.md §4.3): the person tells Nightmail with their own session, then the frame says
    // so. The support Worker allows content only if Nightmail's scope agrees, so a failed call still sends the frame.
    async allowContent(requestId) {
      const conversationId = started?.conversationId ?? load(key)?.conversationId
      if (conversationId) { try { await support.allowContent(conversationId) } catch { /* The Worker asks Nightmail itself. */ } }
      send({ type: 'consent.respond', requestId, decision: 'allow' })
    },
    readAction: (actionId, signal) => actions.get(actionId, signal),
    // Nightmail runs the change for the person's session; the hint only wakes the agent, which reads what came of it
    // from Nightmail itself. A hint lost to a closed socket costs nothing: the agent reads it at its next turn.
    async decideAction(actionId, decision) {
      const action = await actions[decision](actionId)
      send({ type: 'action.resolved', actionId })
      return action
    },
    uploads: true,
    // POST /c/<conversationId>/attachments with the chat token (the one in the socket URL after a reload). If no
    // conversation exists yet ('ready'), starts one first; a rejected token renews through /chat/resume once.
    async upload(file, onProgress, signal) {
      const type = await sniff(file)
      if (!type) throw new Error(UPLOAD_ERRORS.UNSUPPORTED_TYPE)
      for (let tries = 0; ; tries++) {
        if (!started) await connect({ create: true })
        if (!started) throw new Error(`Not connected to ${productName} support yet. Try again in a moment.`)
        const token = started.chatToken || new URL(started.socketUrl).searchParams.get('token') || ''
        const { status, body } = await postImage(`${origin}/c/${encodeURIComponent(started.conversationId)}/attachments`, token, type, file, onProgress, signal)
        if (status === 201 && body?.attachment?.id) return { id: body.attachment.id }
        if (status === 401 && tries === 0) { started = null; generation++; teardown(); state = 'idle'; await connect({ create: true }); continue }
        throw new Error(UPLOAD_ERRORS[body?.error?.code ?? ''] ?? 'The upload failed. Try again.')
      }
    },
    restart() { save(key, null); started = null; wantCreate = false; generation++; teardown(); attempt = 0; setState('ready') },
    // The ticket's conversation is this person's chat now (Nightmail put the message in their open chat, or opened one):
    // reconnecting resumes it, never starts another.
    async file(text) {
      const ticket = await fileTicket(scope, text)
      wantCreate = false
      if (started?.conversationId !== ticket.conversationId) { started = null; save(key, { conversationId: ticket.conversationId }) }
      return ticket
    },
    dispose() { disposed = true; generation++; clearTimeout(retry); teardown(); window.removeEventListener('online', online); listeners.clear() },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

/** No support Worker for this dashboard (supportOrigin() is null): refused from the start (a listener hears it as it
 *  subscribes, so the panel never shows a loading state first), so every message is filed as a ticket for the team. */
export function createUnavailableTransport(scope: RequestScope): SupportTransport {
  const listeners = new Set<(event: TransportEvent) => void>()
  const refused: TransportEvent = { type: 'connection', state: 'unavailable', reason: 'NOT_CONFIGURED' }
  const refuse = () => { for (const listener of listeners) listener(refused) }
  const unavailable = () => Promise.reject(new Error(`${productName} support isn’t available here.`))
  return {
    kind: 'live', connect: refuse, send: () => false, allowContent: async () => {}, readAction: unavailable, decideAction: unavailable, restart: refuse, file: text => fileTicket(scope, text),
    uploads: false, upload: unavailable, dispose: () => listeners.clear(),
    subscribe(listener) { listeners.add(listener); listener(refused); return () => { listeners.delete(listener) } },
  }
}

/** The support Worker for this dashboard: VITE_SUPPORT_ORIGIN, else support.<host> on the hosted service's hosts. */
export function supportOrigin(): string | null {
  const configured = import.meta.env.VITE_SUPPORT_ORIGIN as string | undefined
  if (configured) return configured.replace(/\/$/, '')
  const host = window.location.hostname
  return hostedHosts.includes(host) ? `https://${supportHost(host)}` : null
}
