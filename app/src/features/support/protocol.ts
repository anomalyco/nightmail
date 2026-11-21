// The support chat protocol, v1 (support/PROTOCOL.md on the support Worker's side): one conversation over one
// WebSocket. Unknown fields are ignored and unknown types skipped, so the server can add both without breaking an older
// panel. The scripted demo transport (demo.ts) speaks the same messages.
import type { SupportAction, SupportActionKind } from '../../data/support'

/** staff: a reply from someone on the team, written in the staff inbox (it carries their name as author). */
export type MessageKind = 'first' | 'reply' | 'notice' | 'staff'
export type ConversationStatus = 'open' | 'ticketed' | 'closed'
export type Decision = 'allow' | 'deny'

export interface ConsentRequest { requestId: string; workspace: { id: string; name: string }; why: string }
/** A change the agent proposed (§4.4). The card shows Nightmail's own record of it, read with the person's session, never
 *  this summary: the frame only says there is one. */
export interface ActionRequest { actionId: string; kind: SupportActionKind; summary: string }
export interface TicketFiled {
  ticketId: string
  /** billing, bug, deliverability, account, abuse_report, feature_request or other. Absent from older servers. */
  ticketType?: string
  /** The topic within the type when there is one (refund, limit_increase…), else the type. */
  category: string
  replyTo: string
  expect: string
}
/** A screenshot as the server keeps it (§5.1); the image itself never comes back. */
export interface AttachmentInfo { id: string; type: string; width: number | null; height: number | null; name: string | null }
export interface HistoryMessage { id: string; role: 'assistant' | 'user' | 'staff'; kind?: MessageKind; text: string; at: string; tools?: { id: string; label: string; ok: boolean }[]; attachments?: AttachmentInfo[]; author?: string | null }
export type ErrorCode = 'GRANT_EXPIRED' | 'RATE_LIMITED' | 'TURN_FAILED' | 'BAD_MESSAGE' | 'BUDGET_EXHAUSTED' | (string & {})

type Server<T> = T & { v: 1; seq: number }
export type ServerMessage =
  | Server<{ type: 'hello'; conversationId: string; channel: 'chat' | 'email'; status: ConversationStatus; agent: { name: string; ai: boolean }; customer: { firstName: string | null }; workspace: { id: string; name: string }; contentAccess: boolean; busy: boolean }>
  | Server<{ type: 'history'; messages: HistoryMessage[]; pending: { consent: ConsentRequest | null; ticket: TicketFiled | null; actions?: ActionRequest[] } }>
  | Server<{ type: 'status'; busy: boolean }>
  | Server<{ type: 'message.start'; messageId: string; kind: MessageKind; author?: string }>
  | Server<{ type: 'text.delta'; messageId: string; delta: string }>
  | Server<{ type: 'message.end'; messageId: string; text: string; redacted: boolean }>
  | Server<{ type: 'tool.start'; messageId: string; toolCallId: string; tool: string; label: string }>
  | Server<{ type: 'tool.end'; toolCallId: string; ok: boolean; label: string }>
  | Server<{ type: 'consent.request' } & ConsentRequest>
  | Server<{ type: 'consent.resolved'; requestId: string; decision: Decision }>
  | Server<{ type: 'ticket.filed' } & TicketFiled>
  | Server<{ type: 'action.request' } & ActionRequest>
  | Server<{ type: 'action.resolved'; actionId: string }>
  | Server<{ type: 'error'; code: ErrorCode; message: string; retryable: boolean; retryAfter?: number }>
  | Server<{ type: 'closed'; reason: 'idle' | 'limit' | 'ended' }>
  | { type: 'pong' }

export type ClientMessage =
  | { type: 'user.message'; clientMessageId: string; text: string; attachments?: string[] }
  // handoff: ignored by the current support Worker (Nightmail decides), kept for one release for the previous one.
  | { type: 'consent.respond'; requestId: string; decision: 'allow'; handoff?: string }
  | { type: 'consent.respond'; requestId: string; decision: 'deny' }
  | { type: 'action.resolved'; actionId: string }
  | { type: 'human.request' }
  | { type: 'cancel' }
  | { type: 'feedback'; rating: 'up' | 'down' }
  | { type: 'end' }
  | { type: 'ping' }

/** The longest message the server accepts. */
export const MAX_MESSAGE = 8000
// Screenshots (§5.1): PNG, JPEG or WebP, up to 5 MB each and 5 per conversation. The Worker decides the type from the
// bytes and strips metadata; the panel checks the same way first, so a wrong file is refused before it is sent anywhere.
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type ImageType = (typeof IMAGE_TYPES)[number]
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGES = 5
/** The type by the file's first bytes, as the Worker decides it: a renamed file or a wrong header doesn't pass. */
export async function sniff(file: Blob): Promise<ImageType | null> {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => b[i] === byte)) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  const ascii = (at: number) => String.fromCharCode(...b.subarray(at, at + 4))
  return b.length >= 12 && ascii(0) === 'RIFF' && ascii(8) === 'WEBP' ? 'image/webp' : null
}

const known = new Set(['hello', 'history', 'status', 'message.start', 'text.delta', 'message.end', 'tool.start', 'tool.end', 'consent.request', 'consent.resolved', 'ticket.filed', 'action.request', 'action.resolved', 'error', 'closed', 'pong'])
/** A frame from the socket, or null when it isn't a v1 message this panel knows (skipped, as the protocol asks). */
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== 'string') return null
  let value: unknown
  try { value = JSON.parse(data) } catch { return null }
  if (!value || typeof value !== 'object') return null
  const message = value as { type?: unknown; v?: unknown }
  if (typeof message.type !== 'string' || !known.has(message.type)) return null
  if (message.type !== 'pong' && message.v !== 1) return null
  return value as ServerMessage
}

// Connection state, from the transport (not part of the wire protocol).
export type Connection = 'idle' | 'connecting' | 'open' | 'offline' | 'unavailable'
export type TransportEvent =
  | { type: 'server'; message: ServerMessage }
  | { type: 'connection'; state: Connection; retryAt?: number; reason?: string }

/** What the panel talks to: the support Worker's socket (socket.ts) or the scripted demo (demo.ts). */
export interface SupportTransport {
  readonly kind: 'live' | 'demo'
  /** Opens (or resumes) the conversation. Safe to call again after going offline. */
  connect(): void
  send(message: ClientMessage): boolean
  /** Allow on a consent card: tells Nightmail (content access for this chat), then answers the request; the Worker checks
   *  Nightmail's answer itself. */
  allowContent(requestId: string): Promise<void>
  /** A proposed change as Nightmail keeps it, read with the person's own session (§4.4). */
  readAction(actionId: string, signal?: AbortSignal): Promise<SupportAction>
  /** Confirms or declines it with the person's own session, then tells the server it was decided (action.resolved). */
  decideAction(actionId: string, decision: 'confirm' | 'decline'): Promise<SupportAction>
  /** Forgets this conversation and opens a new one. */
  restart(): void
  /** The last conversation the person wrote in on an earlier page, when it isn't this one: only opened on request. */
  last(): string | null
  /** Opens that conversation in the panel, with its history. */
  continueLast(): void
  /** Whether this transport takes screenshots. */
  readonly uploads: boolean
  /** Uploads one screenshot (§5.1), reporting progress from 0 to 1; the returned att_ ID goes in user.message.attachments.
   *  Rejects with a message to show when the server refuses it. */
  upload(file: File, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<{ id: string }>
  /** Closes the socket for good (a workspace switch). */
  dispose(): void
  subscribe(listener: (event: TransportEvent) => void): () => void
}
