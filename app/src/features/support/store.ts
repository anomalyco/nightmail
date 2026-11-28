import type { ActionRequest, ConsentRequest, Connection, ConversationStatus, MessageKind, ServerMessage, SupportTransport, TicketFiled, TransportEvent } from './protocol'
import type { SupportAction } from '../../data/support'
import { ApiError } from '../../data/types'
import { FileError, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_MESSAGE, sniff } from './protocol'
import { productName } from '../../../../api/src/brand'

// One conversation's state, built from the transport's events. It lives outside React (one per workspace, see
// supportStore), so the conversation, the draft and the unread mark survive navigation, a resize that swaps the shell, and
// closing the panel.
export type ToolState = 'running' | 'done' | 'failed'
export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; label: string; state: ToolState }
  | { kind: 'consent'; request: ConsentRequest; state: 'open' | 'allowing' | 'allow' | 'deny' }
  | { kind: 'ticket'; ticket: TicketFiled; screenshots: number }
  | ActionPart
/** A proposed change (§4.4): `action` is Nightmail's record of it, read with the person's session (null until it loads);
 *  `error` why it couldn't be read or decided. */
/** `unavailable`: Nightmail refused the read itself (another account, gone): final, no decision. Any other failed read
 *  keeps both decisions, with the sentence the server sent and Try again. */
export interface ActionPart { kind: 'action'; request: ActionRequest; action: SupportAction | null; state: 'loading' | 'ready' | 'confirming' | 'declining'; error: string | null; unavailable: boolean }
/** A screenshot in a sent message: its local preview, or none after a reload (the server never sends images back). */
export interface ChatImage { url: string | null; name: string }
/** `local`: only in this panel so far: a message waiting for the connection, or the reply being prepared for it (until
 *  the server's message.start adopts it; `key` keeps it the same element when it does). `filed`: the chat couldn't take
 *  it, so it went to the team as a ticket (`filedId`: its ID in that conversation; `filing` while it goes). */
export interface ChatMessage { id: string; key?: string; role: 'assistant' | 'user'; kind: MessageKind; parts: Part[]; streaming: boolean; restored: boolean; local?: boolean; failed?: string; images?: ChatImage[]; author?: string | null
  filed?: boolean; filedId?: string; filing?: boolean }
/** A screenshot in the message box: uploading as soon as it is added, sent with the next message. */
export interface Attachment { key: string; name: string; url: string; state: 'uploading' | 'ready' | 'failed'; progress: number; attachmentId?: string; error?: string }
type Hello = Extract<ServerMessage, { type: 'hello' }>
export interface ChatState {
  connection: Connection
  retryAt: number | null
  reason: string | null
  hello: Hello | null
  status: ConversationStatus
  messages: ChatMessage[]
  busy: boolean
  closed: 'idle' | 'limit' | 'ended' | null
  /** A conversation-wide limit from the server: RATE_LIMITED (until a time) or BUDGET_EXHAUSTED. */
  limit: { code: string; message: string; until: number | null } | null
  humanRequested: boolean
  /** The initial server check or history replay has completed, so the conversation (or opening line) is ready to show. */
  synced: boolean
  draft: string
  attachments: Attachment[]
  /** Why the last screenshot was refused (type, size or count), until the next one is added or a message is sent. */
  attachError: string | null
  /** Screenshots already sent in this conversation (the limit counts them). */
  imagesSent: number
  unread: boolean
  /** The latest finished message or card, for screen readers (the visible log doesn't announce streaming text). */
  announcement: string
  /** Something went to the team as a ticket in this panel: where they reply by email. */
  ticket: { replyTo: string | null } | null
  /** Why the latest message couldn't be filed, each put back in the message box (and its saved draft): past the hourly
   *  limit with earlier messages with the team (capped) or none (capped_first); or Nightmail couldn't be reached
   *  (waiting: sent again, unchanged, as soon as it can). */
  fileProblem: 'capped' | 'capped_first' | 'waiting' | null
}

const initial = (): ChatState => ({ connection: 'idle', retryAt: null, reason: null, hello: null, status: 'open', messages: [], busy: false, closed: null, limit: null, humanRequested: false, synced: false, draft: '', attachments: [], attachError: null, imagesSent: 0, unread: false, announcement: '', ticket: null, fileProblem: null })
const flat = (text: string) => text.replace(/\s+/g, ' ').trim()
const textOf = (message: ChatMessage) => message.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('\n\n')
// What a screen reader should say: the answer without its Markdown markers.
const spoken = (text: string) => text.replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1').replace(/\*\*([^*\n]+?)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1').replace(/^\s*```.*$/gm, '').replace(/^\s{0,3}[-*•]\s+/gm, '')
const id = () => `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
/** How long a message waits for a lost connection to come back before it goes to the team as a ticket. */
const FILE_AFTER_MS = 8000
/** How soon a message Nightmail couldn't take is tried again (and at once when the browser is back online). */
const FILE_RETRY_MS = 15_000
/** The reply to a message, before the server starts it: its status line shows at once. */
const placeholder = (after: string): ChatMessage => ({ id: `pending_${after}`, key: `pending_${after}`, role: 'assistant', kind: 'reply', parts: [], streaming: true, restored: false, local: true })
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
/** What a ticket is, in a few words, from its type and topic: a report the team works on ("Bug report filed"), or a
 *  request passed to the team ("Billing question passed to the Nightmail team"). Older servers send only the category. */
export function ticketTitle(ticket: TicketFiled) {
  const filed: Record<string, string> = { bug: 'Bug report', abuse_report: 'Abuse report', feature_request: 'Feature request', security: 'Security report' }
  const topics: Record<string, string> = { refund: 'Refund request', billing_dispute: 'Billing question', account_closure: 'Account closure request', limit_increase: 'Limit increase request', enforcement_review: 'Account review request', legal: 'Legal question' }
  const types: Record<string, string> = { billing: 'Billing question', deliverability: 'Deliverability question', account: 'Account question' }
  const category = ticket.category ?? ''
  const kind = filed[ticket.ticketType ?? ''] ?? filed[category]
  if (kind) return `${kind} filed`
  const request = topics[category] ?? types[ticket.ticketType ?? '']
  if (request) return `${request} passed to the ${productName} team`
  return category === 'human_requested' ? `Passed to a person on the ${productName} team` : `Passed to the ${productName} team`
}

/** What a proposed change does, as the card's question. */
export function actionTitle(kind: string) {
  const titles: Record<string, string> = { retry_webhook_delivery: 'Retry a webhook delivery?', test_webhook: 'Send a test webhook?', retry_inbound_delivery: 'Retry an inbound webhook delivery?',
    test_inbound_webhook: 'Send a test to your inbound webhook?', redeliver_message: 'Redeliver a received message?', pause_campaign: 'Pause a campaign?' }
  return titles[kind] ?? 'Make this change?'
}
/** What Confirm does, as its button says it. */
export function actionVerb(kind: string) {
  const verbs: Record<string, string> = { retry_webhook_delivery: 'Retry delivery', test_webhook: 'Send test', retry_inbound_delivery: 'Retry delivery', test_inbound_webhook: 'Send test',
    redeliver_message: 'Redeliver', pause_campaign: 'Pause campaign' }
  return verbs[kind] ?? 'Confirm'
}
export type OutcomeTone = 'success' | 'danger' | 'warning' | 'info' | 'neutral'
/** What came of a decided change, in a few words, from Nightmail's answer: done only queues a test or retry, so its
 *  delivery says whether it has reached the endpoint yet. `waiting`: it may still change (read it again). Null while the
 *  proposal waits for the person. The Help card and the emailed link's dialog both show this. */
export function actionResult(action: SupportAction): { text: string; tone: OutcomeTone; waiting: boolean } | null {
  const test = action.kind === 'test_webhook', http = (code: number | null) => code ? ` (HTTP ${code})` : ''
  switch (action.status) {
    case 'proposed': return null
    case 'running': return { text: 'Sending the test…', tone: 'info', waiting: true }
    case 'declined': return { text: 'Declined.', tone: 'neutral', waiting: false }
    case 'expired': return { text: 'Expired. Ask support again if you still want it.', tone: 'neutral', waiting: false }
    case 'failed':
      // The test was posted, and its answer never recorded: it may or may not have arrived.
      if (action.error?.code === 'SUPPORT_ACTION_OUTCOME_UNKNOWN') return { text: 'Outcome unknown: the test may have reached your endpoint. Check its logs for a test message.received event before testing again.', tone: 'warning', waiting: false }
      return { text: `Didn’t run: ${action.error?.message ?? 'it failed.'}`, tone: 'danger', waiting: false }
    case 'done': {
      if (action.kind === 'pause_campaign') return { text: 'Campaign paused', tone: 'success', waiting: false }
      if (action.kind === 'redeliver_message') return { text: 'Redelivery queued', tone: 'info', waiting: false }
      if (action.kind === 'test_inbound_webhook') {
        const code = typeof action.result?.statusCode === 'number' ? action.result.statusCode : null
        return code !== null && code >= 200 && code < 300 ? { text: `Test message delivered${http(code)}`, tone: 'success', waiting: false }
          : { text: `Your endpoint didn’t accept the test${http(code)}`, tone: 'danger', waiting: false }
      }
      const delivery = action.delivery
      if (delivery?.status === 'delivered') return { text: test ? 'Test event delivered' : 'Delivered', tone: 'success', waiting: false }
      if (delivery?.status === 'failed') return { text: `Your endpoint didn’t accept it${http(delivery.statusCode)}`, tone: 'danger', waiting: false }
      if (delivery?.status === 'paused') return { text: 'Queued, and held while the webhook is paused', tone: 'warning', waiting: false }
      return { text: test ? 'Test event queued' : 'Delivery queued', tone: 'info', waiting: true }
    }
  }
}
/** A proposal that isn't this person's, no longer exists, or a link cut short: every refusal of the request itself. */
export const ACTION_UNAVAILABLE = 'This change isn’t available to this account.'
export const unavailable = (error: unknown) => error instanceof ApiError && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 409 && error.status !== 429
/** Why a proposal couldn't be read or decided, for the card. */
function actionError(error: unknown) {
  if (unavailable(error)) return ACTION_UNAVAILABLE
  return error instanceof Error && error.message ? error.message : `Couldn’t reach ${productName}. Try again.`
}

/** Where the message box survives a reload; `parked` there marks words not yet with the chat or filed, which go on their
 *  own after a reload while the box holds exactly them. */
export type DraftStore = { read: () => string; write: (draft: string) => void; parked?: { read: () => string; write: (text: string) => void } }

export class SupportStore {
  private state: ChatState = initial()
  private listeners = new Set<() => void>()
  private visible = false
  private lastUserMessage: { clientMessageId: string; text: string; attachments?: string[] } | null = null
  /** Messages sent before the conversation was connected, in order: they go out as soon as it is. */
  private outbox: { clientMessageId: string; text: string; attachments?: string[] }[] = []
  /** This live socket's history has arrived, so a message sent now goes directly over the wire. */
  private socketSynced = false
  private pendingHumanRequest = false
  private uploads = new Map<string, AbortController>()
  /** The last message sent over the socket while its answer hasn't started: filed too if the connection drops and stays down. */
  private unanswered: { clientMessageId: string; text: string } | null = null
  private fileTimer: ReturnType<typeof setTimeout> | null = null
  private filingNow = false
  /** The outbox message being filed, until Nightmail answers: saved with the outbox meanwhile. */
  private inFiling: { clientMessageId: string; text: string } | null = null
  /** The words put back in the box because Nightmail couldn't be reached: sent again while the box still holds exactly them. */
  private parked: string | null = null
  private readonly online = () => { if (this.parked) this.retryParked() }
  /** Local previews of sent screenshots by attachment ID, so history after a reconnect still shows them. */
  private previews = new Map<string, string>()
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(readonly transport: SupportTransport, private readonly draftStore?: DraftStore) {
    this.unsubscribe = transport.subscribe(event => this.handle(event))
    window.addEventListener('online', this.online)
    const savedDraft = (draftStore?.read() ?? '').slice(0, MAX_MESSAGE)
    if (savedDraft) this.state = { ...this.state, draft: savedDraft }
    // After a reload: words Nightmail couldn't take are still in the box, and go as soon as they can.
    const parked = draftStore?.parked?.read() ?? ''
    if (parked && parked === savedDraft.trim()) { this.parked = parked; this.state = { ...this.state, fileProblem: 'waiting' }; this.fileTimer = setTimeout(() => this.retryParked(), FILE_RETRY_MS) }
    else if (parked) draftStore?.parked?.write('')
  }
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly getSnapshot = () => this.state
  private set(patch: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) {
    this.state = { ...this.state, ...typeof patch === 'function' ? patch(this.state) : patch }
    for (const listener of this.listeners) listener()
  }
  private update(messageId: string, change: (message: ChatMessage) => ChatMessage) {
    this.set(state => ({ messages: state.messages.map(message => message.id === messageId ? change(message) : message) }))
  }
  // The assistant message a tool step, card or ticket belongs to: the one being written, else the last one.
  private current() { return [...this.state.messages].reverse().find(message => message.role === 'assistant' && message.streaming) ?? [...this.state.messages].reverse().find(message => message.role === 'assistant') }
  private append(part: Part, messageId?: string) {
    const target = (messageId && this.state.messages.find(message => message.id === messageId)) || this.current()
    if (target) this.update(target.id, message => ({ ...message, parts: [...message.parts, part] }))
    else this.set(state => ({ messages: [...state.messages, { id: `local_${state.messages.length}`, role: 'assistant', kind: 'reply', parts: [part], streaming: false, restored: false }] }))
  }

  /** Makes the reply placeholder the server's message `messageId` (for a frame of a message this panel hasn't seen). */
  private adopt(messageId: string, kind?: MessageKind) {
    if (this.state.messages.some(item => item.id === messageId)) return false
    const pending = this.state.messages.find(item => item.local && item.role === 'assistant')
    if (!pending) return false
    this.update(pending.id, item => ({ ...item, id: messageId, kind: kind ?? item.kind, local: false }))
    return true
  }

  setVisible(visible: boolean) { this.visible = visible; if (visible && this.state.unread) this.set({ unread: false }); if (visible) this.rereadFailed() }
  start() { if (this.state.connection === 'idle' && !this.state.hello) this.transport.connect() }
  reconnect() { this.transport.connect({ create: this.outbox.length > 0 || this.pendingHumanRequest }) }
  setDraft(draft: string) {
    const next = draft.slice(0, MAX_MESSAGE)
    // Changed by the person: no longer sent on its own, and no longer what "kept and goes as soon as it can" promised.
    if (this.parked !== null && next.trim() !== this.parked) { this.parked = null; this.set({ draft: next, fileProblem: this.state.fileProblem === 'waiting' ? null : this.state.fileProblem }) }
    else this.set({ draft: next })
    this.save()
  }
  private park(text: string | null) { this.parked = text; this.save() }
  /**
   * Saves what a reload must keep: the message box and, ahead of it, the words sent but not yet with the chat or filed
   * (the outbox, waiting out a reconnect or a filing under way). Those are saved as parked, so after a reload they are
   * back in the box and go on their own, as words Nightmail couldn't take do; once the chat takes them or they are
   * filed, only the box is left. A message already handed to the socket is with the chat: saving it could send it twice.
   */
  private save() {
    if (this.disposed) return
    const held = [...this.inFiling ? [this.inFiling] : [], ...this.outbox].map(item => item.text).filter(Boolean).join('\n\n').trim()
    this.draftStore?.write([held, this.state.draft].filter(Boolean).join('\n\n'))
    this.draftStore?.parked?.write(held || (this.parked ?? ''))
  }
  /** Sends the words Nightmail couldn't take, while the box still holds exactly them: through the chat when it is back, else filed. */
  private retryParked() {
    this.cancelFiling()
    if (this.parked === null || this.disposed) return
    if (this.state.draft.trim() !== this.parked) { this.park(null); return }
    // Not sendable yet (a screenshot still uploading): try again later.
    if (!this.send()) this.fileTimer = setTimeout(() => this.retryParked(), FILE_RETRY_MS)
  }
  /** Whether the message box can be sent: something to send, and every screenshot uploaded. */
  sendable() { const { draft, attachments } = this.state; return (draft.trim() !== '' || attachments.length > 0) && attachments.every(item => item.state === 'ready') }
  /** Sends the message box. It goes in the log at once, with the reply's status line under it; before the conversation
   *  is connected (including when no thread exists yet) it waits in the outbox and creates/connects the thread. */
  send() {
    if (!this.sendable()) return false
    const text = this.state.draft.trim(), attached = this.state.attachments
    const ids = attached.map(item => item.attachmentId!), clientMessageId = id()
    const message = { clientMessageId, text, ...ids.length ? { attachments: ids } : {} }
    // Words Nightmail couldn't take go now, as this message (or were replaced by it): their retry is over.
    if (this.parked !== null) { this.park(null); this.cancelFiling() }
    // A refused chat files it at once, as does a lost connection once a ticket is open here; a lost connection otherwise
    // may be a blip (a deploy, a phone changing networks): it tries again now and waits FILE_AFTER_MS ("Working on it…")
    // before filing, so a few seconds never turn an AI chat into a staff ticket.
    const fileNow = this.state.connection === 'unavailable' || (this.state.connection === 'offline' && this.state.ticket !== null)
    const sent = !this.down() && this.socketSynced && this.transport.send({ type: 'user.message', ...message })
    if (!sent) {
      this.outbox.push(message)
      if (!fileNow) this.transport.connect({ create: true })
      if (!fileNow && this.state.connection === 'offline') this.scheduleFiling(FILE_AFTER_MS)
    } else { this.lastUserMessage = message; this.unanswered = message }
    attached.forEach(item => this.previews.set(item.attachmentId!, item.url))
    // Kept words that go now are no longer waiting: the line saying so goes with them (filing again says it again).
    this.set(state => ({ draft: '', attachments: [], attachError: null, imagesSent: state.imagesSent + ids.length, fileProblem: state.fileProblem === 'waiting' ? null : state.fileProblem,
      messages: [...state.messages, { id: clientMessageId, role: 'user', kind: 'reply', parts: text ? [{ kind: 'text', text }] : [], images: attached.map(({ url, name }) => ({ url, name })), streaming: false, restored: false, local: !sent },
        ...fileNow || state.messages.some(item => item.local && item.role === 'assistant') ? [] : [placeholder(clientMessageId)]] }))
    this.save()
    if (fileNow) void this.fileAll()
    return true
  }
  /** The chat can't take a message now: it refused (unavailable) or its connection is lost (offline). */
  private down() { return this.state.connection === 'offline' || this.state.connection === 'unavailable' }
  /** After a refusal at once, after a lost connection once it has had FILE_AFTER_MS to come back: what the chat couldn't take goes to the team. */
  private scheduleFiling(delay: number) {
    if (this.fileTimer || (!this.outbox.length && !this.unanswered)) return
    // Still not connected (offline, or between two tries): the chat didn't come back in time.
    this.fileTimer = setTimeout(() => { this.fileTimer = null; if (this.state.connection !== 'open') void this.fileAll() }, delay)
  }
  private cancelFiling() { if (this.fileTimer) { clearTimeout(this.fileTimer); this.fileTimer = null } }
  /**
   * Files what the chat couldn't take, oldest first: the messages waiting for the connection, then one sent before the
   * connection dropped whose answer never started. Each is shown as filed once Nightmail holds it. Past the hourly limit,
   * that message and those after it go back into the message box (nothing typed is lost); when Nightmail can't be reached,
   * it stays first in line and is tried again.
   */
  private async fileAll() {
    if (this.filingNow || this.disposed) return
    this.filingNow = true
    this.cancelFiling()
    // A message of screenshots alone has no words to file: it waits for the chat, which takes screenshots.
    const forChat: { clientMessageId: string; text: string; attachments?: string[] }[] = []
    try {
      for (;;) {
        const fromOutbox = this.outbox.length > 0, next = fromOutbox ? this.outbox.shift()! : this.unanswered
        if (!next) break
        if (!fromOutbox) this.unanswered = null
        this.settle()
        if (!next.text) { forChat.push(next); continue }
        if (fromOutbox) this.inFiling = next
        this.update(next.clientMessageId, item => ({ ...item, filing: true }))
        try {
          const ticket = await this.transport.file(next.text)
          if (this.disposed) return
          this.inFiling = null
          this.save()
          this.update(next.clientMessageId, item => ({ ...item, local: false, filing: false, failed: undefined, filed: true, filedId: ticket.messageId }))
          this.set({ ticket: { replyTo: ticket.replyTo }, fileProblem: null, announcement: `Filed as a ticket for the ${productName} team.${ticket.replyTo ? ` They’ll reply to ${ticket.replyTo}.` : ''}` })
        } catch (error) {
          if (this.disposed) return
          this.inFiling = null
          if (error instanceof FileError && error.reason === 'capped') {
            const back = [next, ...this.outbox.splice(0)], ids = new Set(back.map(item => item.clientMessageId))
            this.set(state => ({ messages: state.messages.filter(item => !ids.has(item.id)), fileProblem: state.ticket ? 'capped' : 'capped_first' }))
            this.setDraft([...back.map(item => item.text).filter(Boolean), this.state.draft].filter(Boolean).join('\n\n'))
            break
          }
          // Nightmail couldn't be reached (or this browser is offline): the words go back into the box and its saved
          // draft, so a reload keeps them too, and are sent again, unchanged, as soon as they can.
          const back = [next, ...this.outbox.splice(0)], ids = new Set(back.map(item => item.clientMessageId))
          const draft = [...back.map(item => item.text).filter(Boolean), this.state.draft].filter(Boolean).join('\n\n')
          this.park(draft.trim())
          this.set(state => ({ messages: state.messages.filter(item => !ids.has(item.id)), fileProblem: 'waiting' }))
          this.setDraft(draft)
          this.fileTimer = setTimeout(() => this.retryParked(), FILE_RETRY_MS)
          break
        }
      }
    } finally { this.inFiling = null; this.outbox.push(...forChat); this.filingNow = false; this.save() }
  }
  /** The outbox, once the conversation is connected (after its history). */
  private flush() {
    while (this.outbox.length) {
      const next = this.outbox[0]
      if (!this.transport.send({ type: 'user.message', ...next })) return
      this.outbox.shift()
      this.save()
      this.lastUserMessage = next
      this.unanswered = next
      this.set(state => ({ messages: [...state.messages.map(message => message.id === next.clientMessageId ? { ...message, local: false, failed: undefined } : message),
        ...state.messages.some(message => message.streaming && message.role === 'assistant') ? [] : [placeholder(next.clientMessageId)]] }))
    }
    if (this.pendingHumanRequest && this.transport.send({ type: 'human.request' })) this.pendingHumanRequest = false
    if (this.parked !== null) this.retryParked()
  }
  /** Drops the reply placeholder: no answer is coming for it (a refusal, an error, the end of the conversation). */
  private settle(failed?: string) {
    this.set(state => ({ messages: state.messages.filter(item => !(item.local && item.role === 'assistant')).map(item => item.streaming ? { ...item, streaming: false }
      : failed && item.local && item.role === 'user' ? { ...item, failed } : item) }))
  }
  /** Screenshots pasted, dropped or picked: checked by type (from the bytes), size and the per-conversation limit, then
   *  uploaded at once while the person writes. */
  async attach(files: File[]) {
    if (!this.transport.uploads || !files.length) return
    let error: string | null = null
    const accepted: File[] = []
    for (const file of files) {
      const name = file.name || 'That file'
      if (this.state.imagesSent + this.state.attachments.length + accepted.length >= MAX_IMAGES) { error = `Up to ${MAX_IMAGES} screenshots per conversation.`; break }
      if (!await sniff(file)) { error = `${name} isn’t a PNG, JPEG or WebP image.`; continue }
      if (file.size > MAX_IMAGE_BYTES) { error = `${name} is over 5 MB. Screenshots can be up to 5 MB.`; continue }
      accepted.push(file)
    }
    const added: Attachment[] = accepted.map(file => ({ key: id(), name: file.name || 'Screenshot', url: URL.createObjectURL(file), state: 'uploading', progress: 0 }))
    this.set(state => ({ attachError: error, attachments: [...state.attachments, ...added] }))
    added.forEach((item, i) => this.upload(item.key, accepted[i]))
  }
  private upload(key: string, file: File) {
    const controller = new AbortController()
    this.uploads.set(key, controller)
    const patch = (change: Partial<Attachment>) => this.set(state => ({ attachments: state.attachments.map(item => item.key === key ? { ...item, ...change } : item) }))
    this.transport.upload(file, progress => patch({ progress }), controller.signal)
      .then(({ id: attachmentId }) => patch({ state: 'ready', progress: 1, attachmentId }))
      .catch(error => { if (!controller.signal.aborted) patch({ state: 'failed', error: error instanceof Error ? error.message : 'The upload failed.' }) })
      .finally(() => this.uploads.delete(key))
  }
  /** Removes a screenshot before sending (cancelling its upload). */
  detach(key: string) {
    this.uploads.get(key)?.abort()
    const item = this.state.attachments.find(entry => entry.key === key)
    if (item) URL.revokeObjectURL(item.url)
    this.set(state => ({ attachments: state.attachments.filter(entry => entry.key !== key) }))
  }
  clearAttachError() { if (this.state.attachError) this.set({ attachError: null }) }
  /** TURN_FAILED: resend the same message (the server ignores a clientMessageId it already accepted); messages that never
   *  went out go once the conversation is connected again. */
  retry() {
    if (this.outbox.length) { this.transport.connect({ create: true }); return }
    const last = this.lastUserMessage
    if (!last || !this.transport.send({ type: 'user.message', ...last })) return
    this.set(state => ({ messages: [...state.messages.map(message => message.id === last.clientMessageId ? { ...message, failed: undefined } : message),
      ...state.messages.some(message => message.local && message.role === 'assistant') ? [] : [placeholder(last.clientMessageId)]] }))
  }
  consent(requestId: string, decision: 'allow' | 'deny') {
    this.setConsent(requestId, decision === 'allow' ? 'allowing' : 'deny')
    if (decision === 'deny') this.transport.send({ type: 'consent.respond', requestId, decision: 'deny' })
    else void this.transport.allowContent(requestId)
  }
  private setConsent(requestId: string, state: 'open' | 'allowing' | 'allow' | 'deny') {
    this.set(current => ({ messages: current.messages.map(message => message.parts.some(part => part.kind === 'consent' && part.request.requestId === requestId)
      ? { ...message, parts: message.parts.map(part => part.kind === 'consent' && part.request.requestId === requestId ? { ...part, state } : part) } : message) }))
  }
  /** The change's verb or Decline on an action card: Nightmail decides it for the person's session, and the card shows
   *  what came of it. Open to a decision once Nightmail's record is in, or after a read that failed for a reason other
   *  than the proposal being unavailable (Nightmail checks it anyway, and answers its record). */
  async decideAction(actionId: string, decision: 'confirm' | 'decline') {
    const part = this.actionPart(actionId)
    if (!part || part.state !== 'ready' || part.unavailable || (part.action ? part.action.status !== 'proposed' : !part.error)) return
    this.setAction(actionId, { state: decision === 'confirm' ? 'confirming' : 'declining', error: null })
    try {
      const action = await this.transport.decideAction(actionId, decision)
      this.setAction(actionId, { action, state: 'ready', error: null, unavailable: false })
      this.set({ announcement: actionResult(action)?.text ?? '' })
      this.followAction(action)
    } catch (error) {
      if (this.disposed) return
      this.setAction(actionId, { state: 'ready', error: actionError(error), unavailable: unavailable(error) })
      // Expired, or decided in another tab meanwhile: the card shows where it stands now.
      if (!unavailable(error)) void this.readAction(actionId)
    }
  }
  /** Try again on a card whose read failed. */
  retryAction(actionId: string) { void this.readAction(actionId) }
  private actionPart(actionId: string) {
    for (const message of this.state.messages) for (const part of message.parts) if (part.kind === 'action' && part.request.actionId === actionId) return part
    return null
  }
  private setAction(actionId: string, change: Partial<ActionPart>) {
    this.set(current => ({ messages: current.messages.map(message => message.parts.some(part => part.kind === 'action' && part.request.actionId === actionId)
      ? { ...message, parts: message.parts.map(part => part.kind === 'action' && part.request.actionId === actionId ? { ...part, ...change } : part) } : message) }))
  }
  /** A card for a proposal (once per action), filled from Nightmail's record. */
  private proposeAction(request: ActionRequest) {
    if (!this.actionPart(request.actionId)) this.append({ kind: 'action', request, action: null, state: 'loading', error: null, unavailable: false })
    void this.readAction(request.actionId)
  }
  private async readAction(actionId: string) {
    try {
      const action = await this.transport.readAction(actionId)
      if (this.disposed) return
      const state = this.actionPart(actionId)?.state
      this.setAction(actionId, { action, state: state === 'loading' ? 'ready' : state, error: null, unavailable: false })
      this.followAction(action)
    } catch (error) {
      if (this.disposed || !this.actionPart(actionId)) return
      // A failed read keeps what was shown (an earlier read, or the server's sentence) and both decisions.
      this.setAction(actionId, { state: 'ready', error: unavailable(error) ? ACTION_UNAVAILABLE : `Couldn’t load this from ${productName}.`, unavailable: unavailable(error) })
    }
  }
  /** Failed reads, again: the panel opened, or the connection came back. */
  private rereadFailed() {
    for (const message of this.state.messages) for (const part of message.parts)
      if (part.kind === 'action' && part.error && !part.unavailable && part.state === 'ready') void this.readAction(part.request.actionId)
  }
  /** A test still posting, or a test or retry Nightmail has queued: read it again until its delivery has an answer
   *  (for two minutes after it was decided; a later read, or reopening the link, says the rest). */
  private followAction(action: SupportAction) {
    if (!actionResult(action)?.waiting || Date.now() - Date.parse(action.resolvedAt ?? new Date().toISOString()) > 120_000) return
    setTimeout(() => { if (!this.disposed && this.actionPart(action.id)) void this.readAction(action.id) }, 2500)
  }
  cancel() { this.transport.send({ type: 'cancel' }) }
  requestHuman() {
    if (this.socketSynced && this.transport.send({ type: 'human.request' })) { this.set({ humanRequested: true }); return }
    if (this.state.connection === 'ready') { this.pendingHumanRequest = true; this.set({ humanRequested: true }); this.transport.connect({ create: true }) }
  }
  end() { this.transport.send({ type: 'end' }) }
  restart() { this.lastUserMessage = null; this.unanswered = null; this.cancelFiling(); this.outbox = []; this.pendingHumanRequest = false; this.socketSynced = false; this.set({ ...initial(), draft: this.state.draft }); this.save(); this.transport.restart() }
  dispose() { this.disposed = true; this.cancelFiling(); window.removeEventListener('online', this.online); for (const controller of this.uploads.values()) controller.abort(); this.unsubscribe(); this.transport.dispose(); this.listeners.clear() }

  private handle(event: TransportEvent) {
    if (event.type === 'connection') {
      if (event.state !== 'open') this.socketSynced = false
      const synced = event.state === 'ready' ? true : this.state.synced
      this.set({ connection: event.state, synced, retryAt: event.retryAt ?? null, reason: event.reason ?? null })
      // A refusal files what the chat couldn't take at once; a lost connection gives it FILE_AFTER_MS to come back first.
      if (event.state === 'unavailable') { this.settle(); this.scheduleFiling(0) }
      if (event.state === 'offline') this.scheduleFiling(FILE_AFTER_MS)
      if (event.state === 'open') { this.cancelFiling(); this.rereadFailed() }
      return
    }
    const message = event.message
    switch (message.type) {
      case 'hello':
        this.set({ hello: message, status: message.status, busy: message.busy, closed: message.status === 'closed' ? 'ended' : null })
        break
      case 'history': {
        // History replaces what the panel shows; an open consent card or a filed ticket comes back with it. Screenshots
        // come back as names only (the server never returns the images): this tab's own previews, else placeholders.
        // A staff reply shows as the team's, with its author's name.
        const raw = Array.isArray(message.messages) ? message.messages : []
        const messages: ChatMessage[] = raw.map(item => ({ id: item.id, role: item.role === 'staff' ? 'assistant' : item.role, kind: item.role === 'staff' ? 'staff' : item.kind ?? 'reply', author: item.author ?? null, restored: true, streaming: false,
          images: item.attachments?.map(attachment => ({ url: this.previews.get(attachment.id) ?? null, name: attachment.name || 'Screenshot' })),
          parts: [...(item.tools ?? []).map(tool => ({ kind: 'tool' as const, id: tool.id, label: tool.label, state: tool.ok ? 'done' as const : 'failed' as const })), ...typeof item.text === 'string' && item.text ? [{ kind: 'text' as const, text: item.text }] : []] }))
        const imagesSent = raw.reduce((sum, item) => sum + (item.attachments?.length ?? 0), 0)
        // A message sent just before the connection dropped that never reached the server goes out again, first; one that
        // did and has an answer since needs nothing more.
        const unanswered = this.unanswered, lost = unanswered && !raw.some(item => item.role === 'user' && item.text === unanswered.text) ? unanswered : null
        if (lost) { this.outbox.unshift(lost); this.save() }
        if (lost || messages.at(-1)?.role === 'assistant') this.unanswered = null
        // What the server doesn't have yet stays after its history: messages waiting to go out, and the reply placeholder
        // (one is made for an answer already under way on a reconnect).
        const local = this.state.messages.flatMap(item => item.local ? [item] : item.id === lost?.clientMessageId ? [{ ...item, local: true }] : [])
        // A filed message stays filed: as the server holds it (the same ID, once the support platform took it in), or as
        // this panel showed it until then.
        const filed = new Set(this.state.messages.flatMap(item => item.filed && item.filedId ? [item.filedId] : []))
        const kept = this.state.messages.filter(item => item.filed && !messages.some(entry => entry.id === item.filedId))
        const answering = this.state.busy && messages.at(-1)?.role === 'user' && !local.some(item => item.role === 'assistant')
        this.set({ messages: [...messages.map(entry => filed.has(entry.id) ? { ...entry, filed: true, filedId: entry.id } : entry), ...kept, ...local, ...answering ? [placeholder(messages.at(-1)!.id)] : []], imagesSent: imagesSent + this.outbox.reduce((sum, item) => sum + (item.attachments?.length ?? 0), 0) })
        if (message.pending?.consent) this.append({ kind: 'consent', request: message.pending.consent, state: 'open' })
        if (message.pending?.ticket?.ticketId) this.append({ kind: 'ticket', ticket: message.pending.ticket, screenshots: imagesSent })
        for (const request of message.pending?.actions ?? []) this.proposeAction(request)
        this.socketSynced = true
        if (!this.state.synced) this.set({ synced: true })
        this.flush()
        break
      }
      case 'status': this.set({ busy: message.busy }); break
      case 'message.start':
        if (message.kind !== 'staff') this.unanswered = null
        if (this.state.messages.some(item => item.id === message.messageId)) break
        // The reply's placeholder becomes this message (same element, its status line carries on); else a new one. A staff
        // reply is never the agent's answer: it is its own message, before any placeholder.
        if (message.kind !== 'staff' && this.adopt(message.messageId, message.kind)) break
        this.set(state => {
          const entry: ChatMessage = { id: message.messageId, role: 'assistant', kind: message.kind, author: message.author ?? null, parts: [], streaming: true, restored: false }
          if (message.kind !== 'staff') return { messages: [...state.messages, entry] }
          const pending = state.messages.findIndex(item => item.local && item.role === 'assistant')
          return { messages: pending < 0 ? [...state.messages, entry] : [...state.messages.slice(0, pending), entry, ...state.messages.slice(pending)] }
        })
        break
      case 'text.delta':
        this.adopt(message.messageId)
        this.update(message.messageId, item => {
          const last = item.parts.at(-1)
          return { ...item, parts: last?.kind === 'text' ? [...item.parts.slice(0, -1), { kind: 'text', text: last.text + message.delta }] : [...item.parts, { kind: 'text', text: message.delta.replace(/^\n+/, '') }] }
        })
        break
      case 'message.end': {
        // The final text is what counts: when the output gate replaced it, or it differs from what streamed, it replaces
        // the streamed text (tool steps and cards stay where they were).
        this.adopt(message.messageId)
        const item = this.state.messages.find(entry => entry.id === message.messageId)
        if (!item) break
        const replace = message.redacted || flat(textOf(item)) !== flat(message.text)
        const first = item.parts.findIndex(part => part.kind === 'text')
        const parts: Part[] = !replace ? item.parts : [...item.parts.filter(part => part.kind !== 'text')]
        if (replace && message.text) parts.splice(first < 0 ? parts.length : Math.min(first, parts.length), 0, { kind: 'text', text: message.text })
        this.update(item.id, entry => ({ ...entry, parts, streaming: false }))
        this.set({ announcement: `${productName} Support: ${spoken(message.text ?? '')}`, unread: this.state.unread || !this.visible })
        break
      }
      case 'tool.start': this.adopt(message.messageId); this.append({ kind: 'tool', id: message.toolCallId, label: message.label, state: 'running' }, message.messageId); break
      case 'tool.end':
        this.set(state => ({ messages: state.messages.map(item => item.parts.some(part => part.kind === 'tool' && part.id === message.toolCallId)
          ? { ...item, parts: item.parts.map(part => part.kind === 'tool' && part.id === message.toolCallId ? { ...part, label: message.label, state: message.ok ? 'done' : 'failed' } : part) } : item) }))
        break
      case 'consent.request':
        this.append({ kind: 'consent', request: { requestId: message.requestId, workspace: message.workspace, why: message.why }, state: 'open' })
        this.set({ announcement: `${productName} Support asks to read the content of your emails in ${message.workspace.name}. ${message.why}`, unread: this.state.unread || !this.visible })
        break
      case 'consent.resolved': this.setConsent(message.requestId, message.decision); break
      case 'action.request':
        this.proposeAction({ actionId: message.actionId, kind: message.kind, summary: message.summary })
        this.set({ announcement: `${productName} Support asks you to confirm a change. ${actionTitle(message.kind)}`, unread: this.state.unread || !this.visible })
        break
      // Decided elsewhere (another tab, the emailed link): the card reads where it stands.
      case 'action.resolved': if (this.actionPart(message.actionId)) void this.readAction(message.actionId); break
      case 'ticket.filed': {
        // Screenshots sent in the conversation go with the ticket (§5.1).
        const ticket: TicketFiled = { ticketId: message.ticketId, ticketType: message.ticketType, category: message.category, replyTo: message.replyTo, expect: message.expect }
        this.append({ kind: 'ticket', ticket, screenshots: this.state.imagesSent })
        this.set({ status: 'ticketed', humanRequested: true, announcement: `${ticketTitle(ticket)}: ${message.ticketId}.${message.expect ? ` Someone will reply by email, ${message.expect}.` : ''}` })
        break
      }
      case 'error':
        if (message.code === 'TURN_FAILED') {
          const last = this.lastUserMessage
          if (last) this.update(last.clientMessageId, item => ({ ...item, failed: message.message || 'Couldn’t answer that.' }))
          this.settle()
          this.set({ busy: false })
        } else if (message.code === 'RATE_LIMITED') { this.settle(); this.set({ limit: { code: message.code, message: message.message, until: Date.now() + (message.retryAfter ?? 60) * 1000 } }) }
        else if (message.code === 'BUDGET_EXHAUSTED') { this.settle(); this.set({ limit: { code: message.code, message: message.message, until: null } }) }
        break
      case 'closed':
        this.settle()
        this.set({ closed: message.reason, status: 'closed', busy: false })
        break
    }
  }
}

// One store per account and workspace (and mode). Switching either starts a new conversation, as the protocol asks.
let current: { key: string; store: SupportStore } | null = null
export function supportStore(key: string, create: () => SupportTransport, draft?: DraftStore) {
  if (current?.key !== key) { current?.store.dispose(); current = { key, store: new SupportStore(create(), draft) } }
  return current.store
}
/** Ends the conversation the panel holds (its socket and state): the account in this tab changed or signed out. */
export function endSupport() { current?.store.dispose(); current = null }
