import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { Archive, Inbox, Mail, MailOpen, Paperclip, Reply, Search, Star, Trash2, Undo2, X } from 'lucide-react'
import { Alert, Button, Checkbox, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, IconButton, Input, Pagination, Select, SkeletonText, StatusBadge, Textarea, useToast, fieldError, MutationError, ErrorText } from '../../components/ui'
import { ReceivedEmailPreview } from '../../components/EmailPreview'
import { useApi, useApiDef, useApiMutation, useApiQuery, useSession, useWorkspaceAccess } from '../../data/context'
import { invalidate } from '../../data/invalidation'
import { request } from '../../data/live'
import { OutcomeFlow, outcomeOf } from './flow'
import { firstOverview, useOverview, type Overview } from './overview'
import type { DryRun } from './trace'
import { queries } from '../../data/queries'
import { ApiError, type InboundAddress, type InboundMessage, type InboundThread, type InboundThreadDetail, type InboundThreadPatch, type InboundThreadView, type MailAddress, errorText } from '../../data/types'
import { date, label, time } from '../../lib/format'
import { useCursorPagination } from '../../lib/pagination'
import { ownAddressesOf, replyRecipients, senderOf } from '../../lib/reply-recipients'
import { addressName, addressOption, cleanName, idempotencyFor, nameOf, when } from './shared'
import { nameParts } from '../../lib/private-address'
import '../settings/settings.css'
import './inbound.css'
import { AddressList, NamedAddress, PrivateAddress, Sender } from '../../components/PrivateAddress'

// Until the overview arrives the flow holds its lines; it names nothing yet.
const emptyOverview: Overview = { counts: { address: 0, auto: 0, route: 0, pattern: 0, catch_all: 0, inbox: 0 }, routes: { data: [], nextCursor: null }, rules: [], endpoints: [], endpointsTruncated: false, domains: [], manage: true }
const views: { value: InboundThreadView; label: string }[] = [{ value: 'inbox', label: 'Inbox' }, { value: 'starred', label: 'Starred' }, { value: 'archive', label: 'Archive' }, { value: 'spam', label: 'Spam' }, { value: 'trash', label: 'Trash' }, { value: 'all', label: 'All' }]
const statusTone = (status: string) => status === 'delivered' ? 'success' as const : ['bounced', 'complained', 'rejected', 'suppressed', 'rendering_failed', 'canceled'].includes(status) ? 'danger' as const : status === 'delayed' ? 'warning' as const : 'neutral' as const
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/
type Addresses = Map<string, InboundAddress>
const ownAddresses = (addresses: Addresses) => new Set([...addresses.values()].flatMap(address => [...ownAddressesOf(address)]))

function AddressLabels({ ids, addresses }: { ids: string[]; addresses: Addresses }) {
  return <>{ids.slice(0, 3).map(id => <span key={id} className="mailbox-address-label"><PrivateAddress value={addressName(addresses, id)} /></span>)}{ids.length > 3 && <span className="mailbox-address-label">+{ids.length - 3}</span>}</>
}

// Each row reads like a mail client: who wrote last and when, the subject, then the start of the message, led by the
// address it reached when more than one is in view. The exact time is on each message in the conversation.
function ThreadRow({ thread, addresses, own, showAddresses, selected, focusable, onSelect }: { thread: InboundThread; addresses: Addresses; own: Set<string>; showAddresses: boolean; selected: boolean; focusable: boolean; onSelect: () => void }) {
  const from = thread.from
  return <li role="option" className="mailbox-thread-row" id={`thread-${thread.id}`} data-thread={thread.id} aria-selected={selected} data-selected={selected || undefined} tabIndex={focusable ? 0 : -1} onClick={onSelect}>
    <span className="mailbox-thread-row__top">
      <span className="mailbox-thread-row__people">{!from ? <span className="muted">—</span> : own.has(from.address.toLowerCase()) ? 'You' : <Sender name={from.name} address={from.address} nameOnly />}</span>
      {thread.messageCount > 1 && <span className="mailbox-thread-row__count" aria-label={`${thread.messageCount} messages`}>{thread.messageCount}</span>}
      <time className="mailbox-thread-row__time" dateTime={thread.lastMessageAt}>{when(thread.lastMessageAt)}</time>
    </span>
    <span className="inbound-thread-row__subject" title={thread.subject || undefined}>{thread.subject || '(no subject)'}</span>
    <span className="mailbox-thread-row__snippet">{showAddresses && thread.addressIds.length > 0 && <AddressLabels ids={thread.addressIds} addresses={addresses} />}<span title={thread.snippet || undefined}>{thread.snippet}</span></span>
  </li>
}

// The conversations as a single-select listbox: Tab reaches the open one (or the first), the arrows, Home and End move
// between them, and Enter or Space opens one. Focus moves without opening, so reading a list on a phone never jumps.
function ThreadList({ threads, threadId, onSelect, ...row }: { threads: InboundThread[]; threadId: string | null; onSelect: (id: string) => void; addresses: Addresses; own: Set<string>; addressId?: string }) {
  const [active, setActive] = useState<string | null>(null)
  const current = threads.some(item => item.id === active) ? active : threads.some(item => item.id === threadId) ? threadId : threads[0]?.id ?? null
  function keyDown(event: KeyboardEvent<HTMLUListElement>) {
    const at = threads.findIndex(item => item.id === current)
    const to = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? threads.length - 1 : null
    if (to !== null) {
      event.preventDefault()
      const next = threads[Math.max(0, Math.min(threads.length - 1, to))]
      if (next) { setActive(next.id); document.getElementById(`thread-${next.id}`)?.focus() }
    } else if ((event.key === 'Enter' || event.key === ' ') && current) { event.preventDefault(); onSelect(current) }
  }
  return <ul className="mailbox-threads" role="listbox" aria-label="Conversations" onKeyDown={keyDown} onFocus={event => { const id = (event.target as HTMLElement).dataset.thread; if (id) setActive(id) }}>
    {threads.map(item => <ThreadRow key={item.id} thread={item} addresses={row.addresses} own={row.own} showAddresses={!row.addressId || item.addressIds.length > 1} selected={item.id === threadId} focusable={item.id === current} onSelect={() => onSelect(item.id)} />)}
  </ul>
}

/** Why a received message went where it did: the address and rules it met and where it was delivered, replayed with
 *  its recorded AI answers through today's rules (testRules). Nothing is sent again. */
function WhyItWentHere({ message, address, open, onOpenChange }: { message: InboundMessage; address?: InboundAddress; open: boolean; onOpenChange: (open: boolean) => void }) {
  const overview = useOverview(firstOverview, false, open)
  const why = useApiQuery(['why-it-went-here', message.id], (api, signal) => request<DryRun>('/v1/rules/test', { method: 'POST', body: { messageId: message.id }, signal, scope: api.scope }), { enabled: open })
  const mine = new Set([address?.address, ...(address?.aliases ?? [])].filter((value): value is string => !!value))
  const recipient = why.data?.recipients.find(r => mine.has(r.address))?.address ?? why.data?.recipients[0]?.address ?? address?.address ?? ''
  const error = why.error ?? overview.error
  // A full-height sheet on a phone: the path arrives after the sheet opens and fills it from the top, moving nothing.
  // A replay with today's rules, not the record.
  return <Dialog size="lg" open={open} onOpenChange={onOpenChange} title="Why it went here" analytics="why-it-went-here">
    {error ? <ErrorState error={error} onRetry={() => { void why.refetch(); void overview.refetch() }} />
      : <OutcomeFlow address={recipient} overview={overview.data ?? emptyOverview} outcome={why.data && overview.data ? outcomeOf(why.data, recipient) : null} error={null} addresses={address ? [address] : []} />}
  </Dialog>
}

function MessageCard({ message, addressId, parent, expanded, onToggle, onReply, isTarget, showAddresses, addresses, own }: {
  message: InboundMessage; addressId?: string; parent?: InboundMessage; expanded: boolean; onToggle: () => void; onReply: () => void; isTarget: boolean; showAddresses: boolean; addresses: Addresses; own: Set<string>
}) {
  const api = useApi()
  const toast = useToast()
  const { canAdminister } = useWorkspaceAccess()
  const [why, setWhy] = useState(false)
  const [showQuoted, setShowQuoted] = useState(false)
  const [formatted, setFormatted] = useState(false)
  // Timeline bodies are previews; the full body, HTML and attachments load from the message itself only when asked for.
  const [wanted, setWanted] = useState<null | 'full' | 'formatted' | 'attachments'>(null)
  const detail = useApiQuery(['inbound-message', message.id, addressId ?? null, wanted !== null], (api, signal) => wanted ? api.inbound.message(message.id, { addressId }, signal) : Promise.resolve(null))
  const loaded = detail.data ?? null
  useEffect(() => { if (wanted === 'formatted' && loaded?.html) setFormatted(true) }, [wanted, loaded])
  const outbound = message.direction === 'outbound'
  const unread = message.read === false
  const text = loaded?.text ?? message.text, replyText = loaded?.replyText ?? message.replyText
  const recipients = [...message.to, ...message.cc]
  const extraRecipients = Math.max(0, (message.toCount ?? message.to.length) - message.to.length) + Math.max(0, (message.ccCount ?? message.cc.length) - message.cc.length)
  const hasQuote = text.trim() !== replyText.trim() && replyText.trim().length > 0
  const pending = detail.isFetching && wanted !== null
  async function download(attachmentId: string) {
    try { window.open((await api.inbound.attachmentUrl(message.id, attachmentId, { addressId })).url, '_blank', 'noopener') }
    catch (error) { toast(errorText(error, 'The attachment could not be opened.'), 'error') }
  }
  return <li id={`message-${message.id}`} className="mailbox-message" data-direction={outbound ? 'outbound' : 'inbound'} data-unread={unread || undefined} data-reply-target={isTarget || undefined}>
    <article className="mailbox-message__card">
      {/* Its text is the sender's name: analytics records the click by name, never that text (data-private). */}
      <button type="button" className="mailbox-message__header" onClick={onToggle} aria-expanded={expanded} data-analytics="inbound/message" data-private>
        <span className="mailbox-message__from"><strong><bdi>{outbound ? 'You' : <Sender name={message.from.name} address={message.from.address} nameOnly />}</bdi></strong>{(outbound || nameParts(message.from.name, message.from.address)) && <bdi className="muted"><PrivateAddress value={message.from.address} /></bdi>}</span>
        <span className="mailbox-message__meta">
          {unread && <StatusBadge status="New" tone="info" />}
          {outbound && <StatusBadge status={label(message.status)} tone={statusTone(message.status)} />}
          <time dateTime={message.receivedAt} title={`${date(message.receivedAt)} ${time(message.receivedAt)} UTC`}>{when(message.receivedAt)}</time>
        </span>
      </button>
      <p className="mailbox-message__context">
        <span>to {recipients.length ? <>{recipients.map((person, i) => <span key={`${i}:${person.address}`}>{i > 0 && ', '}{own.has(person.address.toLowerCase()) ? <PrivateAddress value={person.address} /> : <Sender name={person.name} address={person.address} nameOnly />}</span>)}{extraRecipients > 0 && <span className="muted"> +{extraRecipients} more</span>}</> : '—'}</span>
        {showAddresses && <span>via <AddressList values={message.addressIds.map(id => addressName(addresses, id))} /></span>}
        {parent ? <span className="mailbox-message__reply-to"><Undo2 size={12} aria-hidden="true" />Replying to <a href={`#message-${parent.id}`} onClick={event => { event.preventDefault(); document.getElementById(`message-${parent.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }}>{parent.direction === 'outbound' ? 'your message' : <Sender name={parent.from.name} address={parent.from.address} nameOnly />}</a> · {when(parent.receivedAt)}</span>
          : message.inReplyTo ? <span className="mailbox-message__reply-to"><Undo2 size={12} aria-hidden="true" />Reply to an earlier message</span> : null}
      </p>
      {expanded ? <>
        {detail.error && <Alert tone="danger"><ErrorText error={detail.error} /></Alert>}
        {loaded ? loaded.bodyTruncated && <Alert tone="info">Part of this message was too large to store in full.</Alert>
          : message.bodyTruncated && <div className="mailbox-attachments"><Button variant="ghost" size="sm" loading={pending && wanted === 'full'} onClick={() => setWanted('full')}>Show the full message</Button></div>}
        {formatted && loaded?.html && <ReceivedEmailPreview html={loaded.html} tooComplex={loaded.htmlTooComplex} title={`Message from ${nameOf(message.from)}`} className="mailbox-message__html" />}
        {(!formatted || !loaded?.html || loaded.htmlTooComplex) && <div className="mailbox-message__body">{(showQuoted ? text : replyText || text) || <span className="muted">(no text)</span>}</div>}
        <div className="cluster mailbox-message__toggles">
          <Button variant="ghost" size="sm" onClick={onReply} aria-pressed={isTarget}><Reply size={14} aria-hidden="true" />{isTarget ? 'Replying to this' : 'Reply to this message'}</Button>
          {hasQuote && !formatted && <Button variant="ghost" size="sm" onClick={() => setShowQuoted(value => !value)}>{showQuoted ? 'Hide quoted text' : 'Show quoted text'}</Button>}
          {/* Asked for and not there, the button says so in its own place. */}
          {loaded?.html ? <Button variant="ghost" size="sm" onClick={() => setFormatted(value => !value)}>{formatted ? 'Show plain text' : 'Show formatted'}</Button>
            : !loaded ? <Button variant="ghost" size="sm" loading={pending && wanted === 'formatted'} onClick={() => setWanted('formatted')}>Show formatted</Button>
            : wanted === 'formatted' && <Button variant="ghost" size="sm" disabled>No formatted version</Button>}
          {!outbound && canAdminister && <Button variant="ghost" size="sm" onClick={() => setWhy(true)}>Why it went here</Button>}
        </div>
        {message.attachmentCount > 0 && (loaded ? loaded.attachments.length > 0 && <ul className="mailbox-attachments">{loaded.attachments.map(file => <li key={file.id}><button type="button" onClick={() => void download(file.id)}><Paperclip size={12} aria-hidden="true" />{file.filename}<span className="muted">{Math.max(1, Math.round(file.size / 1024))} KB</span></button></li>)}</ul>
          : <div className="mailbox-attachments"><Button variant="ghost" size="sm" loading={pending && wanted === 'attachments'} onClick={() => setWanted('attachments')}><Paperclip size={12} aria-hidden="true" />Show {message.attachmentCount} attachment{message.attachmentCount === 1 ? '' : 's'}</Button></div>)}
      </> : <p className="mailbox-message__snippet muted">{message.snippet}</p>}
      {!outbound && canAdminister && <WhyItWentHere message={message} address={addressId ? addresses.get(addressId) : undefined} open={why} onOpenChange={setWhy} />}
    </article>
  </li>
}

function Conversation({ thread, addressId, addresses, focusMessage, onAddress }: { thread: InboundThreadDetail; addressId?: string; addresses: Addresses; focusMessage: string | null; onAddress: (id: string) => void }) {
  const api = useApi()
  const own = useMemo(() => ownAddresses(addresses), [addresses])
  // Older pages hang off the first page's oldest message; if a refetch moves that boundary, the cursors are stale.
  const [older, setOlder] = useState<{ anchor: string | undefined; messages: InboundMessage[]; cursor: string | null } | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<unknown>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [target, setTarget] = useState<string | null>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const anchor = thread.messages[0]?.id
  const olderPages = older && older.anchor === anchor ? older : null
  useEffect(() => { setOlder(null); setOlderError(null); setExpanded({}); setTarget(null) }, [thread.id, addressId])
  useEffect(() => { if (older && older.anchor !== anchor) { setOlder(null); setOlderError(null) } }, [older, anchor])
  const messages = useMemo(() => {
    const seen = new Set<string>()
    return [...(olderPages?.messages ?? []), ...thread.messages].filter(message => !seen.has(message.id) && seen.add(message.id))
  }, [olderPages, thread.messages])
  const olderCursor = olderPages ? olderPages.cursor : thread.nextCursor
  // Read, star, archive and trash are per address: offer them only when exactly one address is in scope.
  const states = thread.addressStates ?? []
  const stateAddress = addressId ?? (states.length === 1 ? states[0]!.addressId : undefined)
  const flags = stateAddress ? states.find(state => state.addressId === stateAddress) : undefined
  const byMessageId = useMemo(() => new Map(messages.filter(m => m.messageId).map(m => [m.messageId!, m])), [messages])
  const lastId = messages.at(-1)?.id
  const showAddresses = !addressId && thread.addressIds.length > 1
  const focused = useRef<string | null>(null)
  useEffect(() => {
    if (!focusMessage || focused.current === focusMessage || !messages.some(message => message.id === focusMessage)) return
    focused.current = focusMessage
    setExpanded(current => ({ ...current, [focusMessage]: true }))
    requestAnimationFrame(() => document.getElementById(`message-${focusMessage}`)?.scrollIntoView({ block: 'center' }))
  }, [focusMessage, messages])
  const isExpanded = (message: InboundMessage) => expanded[message.id] ?? (message.id === lastId || messages.length <= 3 || message.read === false)
  const toggle = (message: InboundMessage) => setExpanded(current => ({ ...current, [message.id]: !isExpanded(message) }))
  const update = useApiMutation((api, patch: Omit<InboundThreadPatch, 'addressId'>) => api.inbound.updateThread(thread.id, { addressId: stateAddress, ...patch }), undefined, false, invalidate.inboundThreads, [thread.id, stateAddress])
  const act = (patch: Omit<InboundThreadPatch, 'addressId'>) => { update.mutateAsync(patch).catch(() => undefined) }
  async function loadOlder() {
    if (!olderCursor) return
    setLoadingOlder(true); setOlderError(null)
    try { const page = await api.inbound.thread(thread.id, { addressId, cursor: olderCursor }); setOlder({ anchor, messages: [...page.messages, ...(olderPages?.messages ?? [])], cursor: page.nextCursor }) }
    catch (error) { setOlderError(error) }
    finally { setLoadingOlder(false) }
  }
  function replyTo(message: InboundMessage) {
    setTarget(current => current === message.id ? null : message.id)
    requestAnimationFrame(() => composer.current?.focus())
  }
  const replyTarget = messages.find(message => message.id === target) ?? messages.at(-1)!
  return <section className="mailbox-conversation" aria-label="Conversation">
    <header className="mailbox-conversation__header">
      <div className="mailbox-conversation__title">
        <h2>{thread.subject || '(no subject)'}</h2>
        {(!addressId || (flags && flags.labels.length > 0)) && <span className="mailbox-labels">
          {!addressId && <AddressLabels ids={thread.addressIds} addresses={addresses} />}
          {flags?.labels.map(item => <span key={item} className="mailbox-label">{item}</span>)}
        </span>}
      </div>
      {flags && <div className="cluster mailbox-conversation__actions">
        <IconButton variant="ghost" label={flags.unreadCount ? 'Mark read' : 'Mark unread'} onClick={() => act({ read: flags.unreadCount > 0 })}>{flags.unreadCount ? <MailOpen size={16} /> : <Mail size={16} />}</IconButton>
        <IconButton variant="ghost" label={flags.starred ? 'Unstar' : 'Star'} onClick={() => act({ starred: !flags.starred })}><Star size={16} className={flags.starred ? 'mailbox-star' : undefined} /></IconButton>
        <IconButton variant="ghost" label={flags.archived ? 'Move to inbox' : 'Archive'} onClick={() => act({ archived: !flags.archived })}>{flags.archived ? <Inbox size={16} /> : <Archive size={16} />}</IconButton>
        <IconButton variant="ghost" label={flags.trashed ? 'Restore' : 'Move to trash'} onClick={() => act({ trashed: !flags.trashed })}>{flags.trashed ? <Undo2 size={16} /> : <Trash2 size={16} />}</IconButton>
      </div>}
      {/* Read, star, archive and trash belong to one address: with several in view, choosing one (the list's filter) brings them. */}
      {!stateAddress && states.length > 1 && <Select className="address-select-trigger mailbox-conversation__scope" menuClassName="address-select" aria-label="Address to star, archive or mark read as" value="" placeholder="Star or archive as…" onValueChange={onAddress}
        options={states.map(state => addressOption(state.addressId, addressName(addresses, state.addressId)))} />}
    </header>
    <MutationError error={update.error} />
    {olderCursor && <div className="inbound-older">{olderError ? <ErrorState error={olderError} onRetry={() => void loadOlder()} /> : <Button variant="ghost" size="sm" loading={loadingOlder} onClick={() => void loadOlder()}>Show earlier messages</Button>}</div>}
    <ol className="mailbox-messages">
      {messages.map(message => <MessageCard key={message.id} message={message} addressId={addressId} addresses={addresses} own={own} showAddresses={showAddresses}
        parent={message.inReplyTo ? byMessageId.get(message.inReplyTo) : undefined} expanded={isExpanded(message)} onToggle={() => toggle(message)}
        onReply={() => replyTo(message)} isTarget={target === message.id} />)}
    </ol>
    <Composer thread={thread} target={replyTarget} explicit={target !== null && replyTarget.id === target} onClearTarget={() => setTarget(null)} addressId={addressId} addresses={addresses} textarea={composer} />
  </section>
}

// Each recipient's real address is shown on its own, isolated from the sender-chosen name, so a
// name such as "ceo@acme.com" or one with bidi overrides can't pass for the address (L17).
function RecipientList({ label: title, values, people }: { label: string; values: string[]; people: Map<string, MailAddress> }) {
  return <p className="mailbox-composer__to inbound-recipients"><span className="inbound-recipients__label">{title}</span><span className="inbound-recipients__list">{values.map(value => {
    const name = cleanName(people.get(value)?.name)
    return <span key={value} className="inbound-recipient">{name && <bdi className="muted">{name}</bdi>}<bdi className="inbound-recipient__address"><PrivateAddress value={value} /></bdi></span>
  })}</span></p>
}

function Composer({ thread, target, explicit, onClearTarget, addressId, addresses, textarea }: { thread: InboundThreadDetail; target: InboundMessage; explicit: boolean; onClearTarget: () => void; addressId?: string; addresses: Addresses; textarea: RefObject<HTMLTextAreaElement | null> }) {
  const [text, setText] = useState('')
  const [replyAll, setReplyAll] = useState(false)
  const [chosen, setChosen] = useState('')
  const [automated, setAutomated] = useState<string | null>(null)
  const key = useRef({ key: '', body: '' })
  const send = useApiMutation((api, input: Omit<Parameters<typeof api.inbound.reply>[1], 'idempotencyKey'>) => api.inbound.reply(thread.id, { ...input, idempotencyKey: idempotencyFor(key.current, { threadId: thread.id, ...input }) }), 'Reply queued', false, invalidate.inboundReply, thread.id)
  useEffect(() => { setText(''); setReplyAll(false); send.reset(); key.current = { key: '', body: '' } }, [thread.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setChosen('') }, [target.id])
  // A message linked to several addresses needs an explicit sender; the API refuses to guess (ADDRESS_REQUIRED).
  const candidates = target.addressIds
  const fixed = addressId && candidates.includes(addressId) ? addressId : candidates.length === 1 ? candidates[0]! : null
  const sender = fixed ?? (candidates.includes(chosen) ? chosen : null)
  const missing = sender && !addresses.has(sender) ? sender : null
  const lookup = useApiQuery(['inbound-reply-address', missing], (api, signal) => missing ? api.inbound.address(missing, signal) : Promise.resolve(null))
  const senderAddress = (sender ? addresses.get(sender) : undefined) ?? lookup.data
  // The exact To/Cc the API will resolve for this sender; it rejects the send if they differ (expectedRecipients).
  const resolved = senderAddress ? replyRecipients(target, ownAddressesOf(senderAddress), replyAll) : null
  const withAll = senderAddress && !replyAll ? replyRecipients(target, ownAddressesOf(senderAddress), true) : resolved
  const extra = withAll ? withAll.to.length + withAll.cc.length - (resolved?.to.length ?? 0) - (resolved?.cc.length ?? 0) : 0
  const people = useMemo(() => new Map([target.from, ...target.replyTo, ...target.to, ...target.cc].map(person => [person.address.toLowerCase(), person])), [target])
  const redirected = target.direction !== 'outbound' && target.replyTo.length > 0 && target.replyTo.some(person => person.address.toLowerCase() !== target.from.address.toLowerCase())
  // From the built-in domain while it sends to members only, said before the reply is written, not after Send
  // (BUILTIN_DOMAIN_RECIPIENT): an agent and a person both took the refusal for a broken reply.
  const builtin = useSession()?.identity?.connection?.builtinDomain
  const fromHost = senderAddress ? senderOf(senderAddress).address.toLowerCase().split('@')[1] : undefined
  const membersOnly = !!builtin && builtin.scope === 'members' && !!fromHost && (fromHost === builtin.name || fromHost.endsWith(`.${builtin.name}`))
  async function submit(event?: FormEvent, allowAutomated = false) {
    event?.preventDefault()
    if (!text.trim() || !sender || !resolved?.to.length || send.isPending) return
    try {
      await send.mutateAsync({ text: text.trim(), addressId: sender, replyToMessageId: target.id, replyAll, allowAutomated, expectedRecipients: resolved })
      setText(''); setReplyAll(false); onClearTarget(); key.current = { key: '', body: '' }
    } catch (error) { if (error instanceof ApiError && ['REPLY_TO_AUTOMATED', 'REPLY_TO_NO_REPLY'].includes(error.code)) { send.reset(); setAutomated(error.detail) } }
  }
  const changed = send.error instanceof ApiError && send.error.code === 'INBOUND_RECIPIENTS_CHANGED'
  return <form className="mailbox-composer" data-filled={text ? true : undefined} onSubmit={submit}>
    <div className="inbound-composer__target">
      <label className="mailbox-composer__to" htmlFor="inbound-reply">{explicit ? `Replying to ${target.direction === 'outbound' ? 'your message' : `${nameOf(target.from)}’s message`} from ${when(target.receivedAt)}` : 'Replying to the newest message'}</label>
      {explicit && <IconButton variant="ghost" size="sm" label="Reply to the newest message instead" onClick={onClearTarget}><X size={14} /></IconButton>}
    </div>
    {!fixed && <Field label="Send as" htmlFor="inbound-reply-sender" error={fieldError(send.error, 'addressId')}>
      <Select id="inbound-reply-sender" className="address-select-trigger" menuClassName="address-select" value={sender ?? ''} onValueChange={setChosen} disabled={send.isPending} placeholder="Choose an address" options={candidates.map(id => addressOption(id, addressName(addresses, id)))} />
    </Field>}
    <div className="inbound-recipients-review" aria-label="Reply recipients">
      {lookup.error && <ErrorState error={lookup.error} onRetry={() => void lookup.refetch()} />}
      {sender && !senderAddress ? <p className="mailbox-composer__to">The sending address could not be loaded, so its recipients can’t be reviewed.</p>
        : !senderAddress || !resolved ? <p className="mailbox-composer__to">Choose the sending address to review recipients.</p> : <>
          <RecipientList label="From" values={[senderOf(senderAddress).address.toLowerCase()]} people={new Map([[senderOf(senderAddress).address.toLowerCase(), senderOf(senderAddress)]])} />
          {resolved.to.length ? <RecipientList label="To" values={resolved.to} people={people} /> : <p className="mailbox-composer__to">This reply has no recipients outside your own addresses.</p>}
          {resolved.cc.length > 0 && <RecipientList label="Cc" values={resolved.cc} people={people} />}
          {membersOnly && <p className="mailbox-composer__to inbound-recipients__warning">{builtin!.repliesToSenders
            ? <>{builtin!.name} is your built-in domain: for now it replies to members of this workspace, and once to a sender who wrote to it and passed authentication. To answer anyone else, <Link to="/domains">add a domain of your own</Link>.</>
            : <>{builtin!.name} is your built-in domain: for now it replies only to members of this workspace. To answer anyone else, <Link to="/domains">add a domain of your own</Link>.</>}</p>}
          {redirected && <p className="mailbox-composer__to inbound-recipients__warning">The sender asked for replies to a different address than the one it came from (<bdi><PrivateAddress value={target.from.address} /></bdi>).</p>}
        </>}
    </div>
    <Textarea ref={textarea} id="inbound-reply" rows={2} value={text} onChange={event => setText(event.target.value)} placeholder="Write a reply" disabled={send.isPending} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit() }} />
    {send.error && <Alert tone="danger">{changed ? 'The recipients changed. Check To and Cc above, then send again.' : <ErrorText error={send.error} />}</Alert>}
    <div className="mailbox-composer__actions">
      {replyAll || extra > 0 ? <Checkbox label={replyAll ? 'Reply all' : `Reply all (+${extra})`} checked={replyAll} onCheckedChange={setReplyAll} disabled={send.isPending} /> : <span />}
      <Button variant="primary" type="submit" loading={send.isPending} disabled={!text.trim() || !resolved?.to.length}>Send reply</Button>
    </div>
    <ConfirmDialog open={!!automated} onOpenChange={open => { if (!open) setAutomated(null) }} title="Send to an automated sender?" description={`${automated ?? ''} Replying to automated mail can start a loop between systems.`} confirmLabel="Send anyway" onConfirm={() => submit(undefined, true)} />
  </form>
}

function NewThreadDialog({ open, onOpenChange, addresses, defaultAddress, onSent }: { open: boolean; onOpenChange: (open: boolean) => void; addresses: InboundAddress[]; defaultAddress?: string; onSent: (threadId: string, fromAddressId: string) => void }) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const key = useRef({ key: '', body: '' })
  const send = useApiMutation((api, input: Omit<Parameters<typeof api.inbound.startThread>[0], 'idempotencyKey'>) => api.inbound.startThread({ ...input, idempotencyKey: idempotencyFor(key.current, input) }), 'Message queued', false, invalidate.inboundReply)
  useEffect(() => { if (open) { send.reset(); setErrors({}); setFrom(current => current || defaultAddress || (addresses.length === 1 ? addresses[0]!.id : '')) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const selected = addresses.find(address => address.id === from)
  const sender = selected ? senderOf(selected) : null
  async function submit(event: FormEvent) {
    event.preventDefault()
    const recipients = to.split(/[\s,;]+/).map(value => value.trim()).filter(Boolean)
    const next: Record<string, string> = {}
    if (!from) next.addressId = 'Choose the address to send from.'
    if (!recipients.length) next.to = 'Add at least one recipient.'
    else if (recipients.some(value => !EMAIL.test(value))) next.to = 'Enter valid email addresses, separated by commas.'
    if (!subject.trim()) next.subject = 'Enter a subject.'
    if (!text.trim()) next.text = 'Write a message.'
    setErrors(next)
    if (Object.keys(next).length) return
    try {
      const message = await send.mutateAsync({ addressId: from, to: recipients, subject: subject.trim(), text: text.trim() })
      key.current = { key: '', body: '' }; setTo(''); setSubject(''); setText('')
      onOpenChange(false); onSent(message.threadId, from)
    } catch { /* Shown in the form. */ }
  }
  return <Dialog open={open} onOpenChange={next => { if (!send.isPending) onOpenChange(next) }} title="New message" footer={<><Button disabled={send.isPending} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" form="inbound-new-thread" loading={send.isPending}>Send</Button></>}>
    <form id="inbound-new-thread" className="stack" onSubmit={submit} noValidate>
      <MutationError error={send.error} />
      <Field label="Address" htmlFor="inbound-new-from" error={errors.addressId || fieldError(send.error, 'addressId')} hint={selected && sender && sender.address !== selected.address ? <>Sends as <NamedAddress name={sender.name} address={sender.address} />.</> : undefined}>
        <Select id="inbound-new-from" className="address-select-trigger" menuClassName="address-select" value={from} onValueChange={setFrom} disabled={send.isPending} placeholder="Choose an address" options={addresses.map(address => addressOption(address.id, address.address, address.displayName ?? undefined))} />
      </Field>
      <Field label="To" htmlFor="inbound-new-to" error={errors.to || fieldError(send.error, 'to')}><Input id="inbound-new-to" value={to} onChange={event => setTo(event.target.value)} disabled={send.isPending} placeholder="name@example.com, …" autoComplete="off" /></Field>
      <Field label="Subject" htmlFor="inbound-new-subject" error={errors.subject || fieldError(send.error, 'subject')}><Input id="inbound-new-subject" value={subject} onChange={event => setSubject(event.target.value)} disabled={send.isPending} /></Field>
      <Field label="Message" htmlFor="inbound-new-text" error={errors.text || fieldError(send.error, 'text')}><Textarea id="inbound-new-text" rows={8} value={text} onChange={event => setText(event.target.value)} disabled={send.isPending} /></Field>
    </form>
  </Dialog>
}

/** One address's mail (its page's Mail tab): its conversations beside the open one, with search, views and New message.
 *  Received mail lives per address; every address's together is Logs, filtered to received. */
/** `enabled` false: the address was just deleted, so its mail is not read again. */
export function AddressMail({ addressId, hidden = false, enabled = true }: { addressId: string; hidden?: boolean; enabled?: boolean }) {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const view = (views.some(item => item.value === params.get('view')) ? params.get('view') : 'inbox') as InboundThreadView
  const threadId = params.get('thread')
  const [search, setSearch] = useState('')
  const [composing, setComposing] = useState(false)
  const pagination = useCursorPagination()
  const addressList = useApiDef(queries.inboundAddressOptions())
  const missing = !!addressList.data && !addressList.data.some(address => address.id === addressId)
  const linked = useApiQuery(['inbound-address', addressId, missing], (api, signal) => missing ? api.inbound.address(addressId, signal) : Promise.resolve(null), { enabled })
  const addresses = useMemo<Addresses>(() => new Map([...(addressList.data ?? []), ...(linked.data ? [linked.data] : [])].map(address => [address.id, address])), [addressList.data, linked.data])
  const own = useMemo(() => ownAddresses(addresses), [addresses])
  const q = search.trim()
  const threads = useApiDef(queries.inboundThreads(addressId, view, q, pagination.cursor), { interval: 30_000, keepPrevious: true, enabled })
  const thread = useApiQuery(['inbound-thread', threadId, addressId], (api, signal) => threadId ? api.inbound.thread(threadId, { addressId }, signal) : Promise.resolve(null), { enabled })
  function change(changes: Record<string, string | null>) {
    setParams(previous => {
      const next = new URLSearchParams(previous)
      for (const [name, value] of Object.entries(changes)) { if (value === null) next.delete(name); else next.set(name, value) }
      return next
    })
  }
  return <div className="mailbox-page" hidden={hidden} data-thread-open={threadId ? true : undefined}>
    <div className="mailbox-layout">
      <aside className="mailbox-list" aria-label="Conversations">
        <div className="mailbox-toolbar">
          <div className="search-box mailbox-search"><Search size={16} /><Input type="search" aria-label="Search conversations" placeholder="Search mail" value={search} onChange={event => { setSearch(event.target.value); pagination.reset() }} /></div>
          {/* The views are one picker beside search: the address's own tabs are the page's only row of tabs. */}
          <Select className="mailbox-view" aria-label="Conversation view" value={view} onValueChange={value => { pagination.reset(); change({ view: value === 'inbox' ? null : value, thread: null, message: null }) }} options={views} />
          <Button onClick={() => setComposing(true)} disabled={!addresses.has(addressId)}>New message</Button>
        </div>
        {threads.error ? <ErrorState error={threads.error} onRetry={() => void threads.refetch()} /> : threads.isPending ? <div className="mailbox-thread-skeleton">{[0, 1, 2, 3].map(index => <div key={index}><SkeletonText width="40%" /><SkeletonText width="60%" /><SkeletonText width="85%" /></div>)}</div>
          : threads.data.length ? <>
            <ThreadList threads={threads.data} threadId={threadId} addresses={addresses} own={own} addressId={addressId} onSelect={id => change({ thread: id, message: null })} />
            {(pagination.page > 1 || threads.data.nextCursor) && <Pagination page={pagination.page} pageSize={50} nextCursor={threads.data.nextCursor} onPageChange={next => pagination.onPageChange(next, threads.data.nextCursor)} />}
          </> : <EmptyState title={q ? 'No matching conversations' : view === 'inbox' ? 'No mail yet' : `Nothing in ${views.find(item => item.value === view)!.label.toLowerCase()}`} />}
      </aside>
      <div className="mailbox-reader">
        {!threadId ? null
          : thread.error ? <ErrorState error={thread.error} onRetry={() => void thread.refetch()} />
          // Its names wait for the addresses too: a conversation drawn before them rewrites "you" and its senders in place.
          : thread.isPending || !thread.data || addressList.isPending ? <div className="mailbox-thread-skeleton"><SkeletonText width="50%" lineHeight={24} /><SkeletonText width="80%" /><SkeletonText width="70%" /></div>
          : <Conversation thread={thread.data} addressId={addressId} addresses={addresses} focusMessage={params.get('message')} onAddress={() => undefined} />}
      </div>
    </div>
    {/* A message sent from another of the workspace's addresses lives on that address's page. */}
    <NewThreadDialog open={composing} onOpenChange={setComposing} addresses={[...addresses.values()]} defaultAddress={addressId} onSent={(id, from) => from === addressId ? change({ thread: id, message: null }) : navigate(`/receiving/addresses/${encodeURIComponent(from)}?thread=${encodeURIComponent(id)}`)} />
  </div>
}

/** /receiving/inbox, the inbox of every address before mail moved to each address's page: with ?address= it opens that
 *  address's Mail tab (thread, view and message kept), else Logs' received mail. */
export function InboundPage() {
  const location = useLocation()
  const params = new URLSearchParams(location.search), address = params.get('address')
  params.delete('address')
  if (!address) return <Navigate replace to="/logs?view=received" />
  params.set('tab', 'mail')
  return <Navigate replace to={`/receiving/addresses/${encodeURIComponent(address)}?${params}${location.hash}`} />
}
