import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Mail, MessageSquare } from 'lucide-react'
import { Button, DataTable, DropdownMenu, EmptyState, ErrorState, PageHeader, StatusBadge, type Column } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useRequestScope } from '../../data/context'
import { listQuery, prefetchConversation, type Channel, type InboxView, type SupportConversation } from '../../data/support-inbox'
import { ago } from '../../lib/format'
import { useSearchDraft } from '../../lib/pagination'
import { usePhone } from '../../lib/media'
import { StaffOnly } from '../operator/skeletons'
import { ConfirmAction, flatten, memory, menuItems, ShortcutsDialog, titleOf, useInboxActions, useRole, useShortcuts, when, type Confirming } from './actions'
import { channelOf, InboxTabs, InboxToolbar, inboxColumnDefs, SupportInboxSkeleton, triageOf, viewOf } from './skeletons'

export { SupportConversationPage } from './conversation'

// The support inbox (lazy, /support): Nightmail staff triage every support conversation. Needs you (the default) is
// what only a person can move forward, most urgent first (api/src/support-inbox.ts); AI handling is what the agent owes
// the next message in; Waiting on customer has been answered; Done and All. Each row previews the last message itself.
// A conversation opens as a chat (conversation.tsx). Keyboard first: j and k move, Enter or o opens, Esc goes back,
// r replies, n adds a note, e marks done (and moves on; Undo on its toast), h hands back, u marks read or unread,
// / searches, ? lists the keys. In the list the selected row and the focused one are always the same, so a key acts on
// what is on screen. Lists and conversations come from the query cache at once and refresh behind it; a conversation is
// read ahead on hover, on selection and next to the open one, so moving between them never waits. Changes show before
// the API answers.

const def = (key: string) => inboxColumnDefs.find(column => column.key === key)!
const lastActivity = (c: SupportConversation) => c.lastMessageAt ?? c.createdAt

// ---------------------------------------------------------------- cells

const ChannelIcon = ({ channel }: { channel: SupportConversation['channel'] }) => channel === 'email' ? <Mail size={14} aria-label="Email" /> : channel === 'agent_feedback' ? <Bot size={14} aria-label="Agent feedback" /> : <MessageSquare size={14} aria-label="Chat" />
/** Who filed agent feedback, short, from its Filed by (api/src/feedback.ts): the API key's name, the MCP sign-in's app and
 *  person, the agent token's purpose. An address stays behind the blur-addresses setting. */
function Filer({ text }: { text: string }) {
  const quoted = /"([^"]+)"/.exec(text)?.[1], email = /\bby (\S+@\S+)$|\bof (\S+@\S+)$/.exec(text), address = email?.[1] ?? email?.[2]
  const what = text.startsWith('the API key') ? `${quoted ?? 'API key'} (API key)` : text.startsWith('an MCP sign-in') ? `${quoted ?? 'An app'} (MCP)`
    : text.startsWith('an agent token') ? `${quoted ?? 'An agent'} (agent token)` : text.startsWith('the dashboard') ? 'Dashboard' : text
  return <>{what}{address && <> · <PrivateAddress value={address} /></>}</>
}
// Who a conversation is from: the person, else the address, else the workspace (agent feedback's, with who filed it in
// the words of its Filed by); "Unknown sender" only when nothing is known.
function Who({ c }: { c: SupportConversation }) {
  const address = c.customer?.email ?? c.sender
  return <span className="sinbox-who" data-unread={c.unread || undefined}>
    <span className="sinbox-unread" role={c.unread ? 'img' : undefined} aria-label={c.unread ? 'Unread' : undefined} />
    <span className="sinbox-channel"><ChannelIcon channel={c.channel} /></span>
    <span className="sinbox-who__name">{c.customer?.name ?? (address ? <PrivateAddress value={address} /> : c.workspace?.name ?? 'Unknown sender')}</span>
    {!c.customer?.name && !address && c.workspace && c.filedBy && <span className="sinbox-who__by"><Filer text={c.filedBy} /></span>}
  </span>
}
const previewBy = (p: NonNullable<SupportConversation['preview']>) => p.held ? 'AI draft, not sent: ' : p.author === 'agent' ? 'AI: ' : p.author === 'staff' ? 'Staff: ' : ''
// The subject (or the customer's first line), then the last message itself, muted, on the same line.
const previewOf = (c: SupportConversation) => c.preview && c.preview.text !== titleOf(c) ? c.preview : null
// Agent feedback has one message, its subject: its card's second line says what it is instead of repeating it.
const Preview = ({ c }: { c: SupportConversation }) => { const preview = previewOf(c); return preview ? <span className="sinbox-preview"><span className="sinbox-preview__by">{previewBy(preview)}</span>{preview.text}</span> : c.channel === 'agent_feedback' ? <span className="sinbox-preview">Report from an agent · nobody to reply to</span> : null }
const Subject = ({ c, preview = true }: { c: SupportConversation; preview?: boolean }) => <span className="sinbox-subject">
  <span className="sinbox-subject__text" data-placeholder={c.subject || c.firstLine ? undefined : ''}>{titleOf(c)}</span>
  {preview && previewOf(c) && <Preview c={c} />}
</span>

// ---------------------------------------------------------------- the list

export function SupportInboxPage() {
  const scope = useRequestScope()
  const role = useRole(), canAct = role === 'operator'
  const location = useLocation(), navigate = useNavigate(), client = useQueryClient(), phone = usePhone()
  const [params, setParams] = useSearchParams()
  const view = viewOf(location.search), channel = channelOf(location.search), q = (params.get('q') ?? '').trim()
  const [search, setSearch] = useSearchDraft(params.get('q') ?? '', value => setParams(previous => { const next = new URLSearchParams(previous); if (value.trim()) next.set('q', value.trim()); else next.delete('q'); return next }, { replace: true }))
  useEffect(() => { memory.list = { view, q, channel } }, [view, q, channel])
  const setChannel = (next: Channel | '') => setParams(previous => { const params = new URLSearchParams(previous); if (next) params.set('channel', next); else params.delete('channel'); return params }, { replace: true })
  // A search keeps the rows it replaces until its answer arrives; another tab never shows this one's.
  const list = useInfiniteQuery({ ...listQuery(scope, view, q, channel), enabled: Boolean(role), staleTime: 5_000, refetchInterval: query => query.state.status === 'error' ? false : 30_000,
    placeholderData: (previous, query) => query?.queryKey[2] === view ? previous : undefined })
  const rows = flatten(list.data?.pages), counts = list.data?.pages[0]?.counts ?? null
  // Each view keeps its own selected row.
  const [selection, setSelection] = useState(() => ({ ...memory.selected }))
  const setSelectedId = (id: string) => setSelection(current => ({ ...current, [view]: id }))
  const index = Math.max(0, rows.findIndex(c => c.id === selection[view])), selected = rows[index]
  useEffect(() => { if (selected) memory.selected[view] = selected.id }, [view, selected?.id])
  const [confirming, setConfirming] = useState<Confirming | null>(null), [keysOpen, setKeysOpen] = useState(false)
  const actions = useInboxActions()
  // The other view's first page loads once this one has, so switching tabs never waits.
  useEffect(() => {
    if (!list.data || !role) return
    const other: InboxView = view === 'needs_you' ? 'all' : 'needs_you'
    void client.prefetchInfiniteQuery({ ...listQuery(scope, other, ''), staleTime: 5_000 })
  }, [Boolean(list.data), role])
  // The selected row is read ahead (once it has stayed selected a moment), and kept in view.
  useEffect(() => {
    if (!selected || phone) return
    const timer = window.setTimeout(() => void prefetchConversation(client, scope, selected.id), 120)
    document.querySelector('.sinbox-table tr[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
    return () => window.clearTimeout(timer)
  }, [selected?.id])
  const open = (c: SupportConversation, reply = false) => { memory.selected[view] = c.id; navigate(`/support/${c.id}`, { state: { reply } }) }
  // Selecting a row from inside the list takes focus with it, so the focused row is always the one a key acts on.
  const select = (id: string) => {
    setSelectedId(id)
    if (document.activeElement?.closest('.sinbox-table')) requestAnimationFrame(() => document.querySelector<HTMLElement>('.sinbox-table [data-selected="true"] .ui-row-link')?.focus({ preventScroll: true }))
  }
  const move = (step: number) => {
    const next = rows[index + step]
    if (next) select(next.id)
    if (step > 0 && index + step >= rows.length - 3 && list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage()
  }
  useShortcuts({
    j: () => move(1), k: () => move(-1), Enter: () => selected && open(selected), o: () => selected && open(selected), r: () => selected && canAct && open(selected, true),
    // e acts on the row on screen when it is pressed; with nothing to mark it only moves on.
    e: () => {
      if (!selected) return
      if (!canAct || !selected.needsYou) { move(1); return }
      const target = selected, after = rows[index + 1] ?? rows[index - 1]
      if (view === 'needs_you' && after) select(after.id)
      void actions.done(target)
    },
    h: () => { if (selected && canAct && selected.agentState === 'paused' && selected.status !== 'closed') setConfirming({ action: 'resume', conversation: selected }) },
    u: () => selected && void actions.read(selected, selected.unread), '?': () => setKeysOpen(true),
  }, Boolean(role))
  if (!role) return <StaffOnly />
  if (!list.data && !list.isError) return <SupportInboxSkeleton view={view} channel={channel} />
  const columns: Column<SupportConversation>[] = [
    { ...def('customer'), render: c => <Who c={c} /> },
    { ...def('subject'), render: c => <Subject c={c} />, cardRender: c => <Subject c={c} preview={false} /> },
    { ...def('preview'), render: c => <Preview c={c} /> },
    { ...def('status'), render: c => { const s = triageOf(c); return <StatusBadge status={s.text} tone={s.tone} /> } },
    { ...def('activity'), render: c => <time className="nowrap" dateTime={lastActivity(c)} title={when(lastActivity(c))}>{ago(lastActivity(c))}</time> },
    { ...def('actions'), render: c => <DropdownMenu label="Conversation actions" title={titleOf(c)} items={menuItems(c, { canAct, actions, onConfirm: setConfirming })} /> },
  ]
  const empty = q || channel ? <EmptyState title="No conversation matches" action={<Button onClick={() => { setSearch(''); setChannel('') }}>Clear filters</Button>} />
    : <EmptyState title={view === 'needs_you' ? 'Nothing needs you' : 'No support conversations yet'} />
  return <>
    <PageHeader title="Support" actions={<DropdownMenu label="Support menu" title="Support" items={[{ label: 'Your agents', onSelect: () => navigate('/operator/agents') }]} />} />
    <div className="sinbox-page">
      <InboxTabs view={view} counts={counts} onChange={next => setParams(previous => { const params = new URLSearchParams(previous); if (next === 'needs_you') params.delete('view'); else params.set('view', next); return params }, { replace: true })} />
      <InboxToolbar search={search} onSearch={setSearch} channel={channel} onChannel={setChannel} />
      {list.isError && !list.data ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : <>
        <DataTable key={view} className="sinbox-table" rows={rows} rowKey={c => c.id} columns={columns} selectedId={phone ? undefined : selected?.id} empty={empty} rowKeys={false}
          rowHref={c => `/support/${c.id}`} rowLabel={titleOf} onRowIntent={c => void prefetchConversation(client, scope, c.id)} onRowFocus={phone ? undefined : c => setSelectedId(c.id)} />
        {list.hasNextPage && <Button className="sinbox-more" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more</Button>}
      </>}
    </div>
    <ConfirmAction confirming={confirming} onClose={() => setConfirming(null)} actions={actions} />
    <ShortcutsDialog open={keysOpen} onClose={() => setKeysOpen(false)} />
  </>
}
