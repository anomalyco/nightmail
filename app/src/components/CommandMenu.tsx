import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, Bot, Check, ChevronRight, CornerDownLeft, Eye, EyeOff, Globe, KeyRound, Lock, LogOut, Mail, MessageCircleQuestionMark, Moon, Search, Send, Server, Sun, type LucideIcon } from 'lucide-react'
import { sectionPath, useApi, useSession, useWorkspaceAccess } from '../data/context'
import { useAccounts, withOwnAccount } from '../data/accounts'
import { isAbortError, request } from '../data/live'
import { queries } from '../data/queries'
import { resourceOf } from '../data/invalidation'
import { preferredSendingDomain } from '../lib/domain'
import { errorText } from '../data/types'
import { openConnectAgent } from '../lib/connect-agent'
import { togglePrivacy, usePrivacy } from '../lib/privacy'
import { useTheme } from '../lib/theme'
import { useMailServers } from '../features/docs/mail-settings'
import { Dialog, Icon, useToast } from './ui'

// ⌘K: every page of the shell and the things you'd otherwise hunt for (connect an agent, a new key, SMTP and IMAP
// settings, a domain, a test email, Help, the theme, another workspace, Sign out), filtered as you type. With nothing
// typed it lists what you used last, then the pages with their G shortcuts, then the actions. Arrow keys (or Ctrl+N and Ctrl+P) move, Enter runs,
// Escape closes; Switch workspace opens a list of its own, and Backspace in an empty field goes back. It opens on the
// next frame with nothing animated (it is reached for many times a day) and floats over the page, so nothing moves.
export type Shortcut = { keys: string[]; label: string }
export type Command = {
  /** Stable, for the recent list, and named in analytics (letters and hyphens only). */
  id: string
  title: string
  icon: LucideIcon | null
  section: 'Pages' | 'Actions'
  /** The page it opens, for pages. */
  path?: string
  shortcut?: Shortcut
  /** Other words it answers to: the old name of a page, what people call the thing. */
  words?: string
  locked?: boolean
  /** Muted text after the title (the account a workspace belongs to). */
  note?: string
  /** Found by searching only, never in the full list (a workspace to switch to). */
  searchOnly?: boolean
  /** It's the one you're in (a workspace). */
  current?: boolean
  /** Names people's data (a workspace, an account): kept out of analytics and UI notes. */
  personal?: boolean
  /** Opens a list of its own instead of running. */
  opens?: 'workspaces'
  run?: () => void
}
type Group = { label: string | null; items: Command[] }

// What you ran last, newest first, in this browser.
const RECENT_KEY = 'nightmail.command-recent', RECENT_KEPT = 8, RECENT_SHOWN = 4
function readRecent(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, RECENT_KEPT) : [] } catch { return [] }
}
function remember(id: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter(item => item !== id)].slice(0, RECENT_KEPT))) } catch { /* The list just isn't kept. */ }
}

// Matching: the whole title, then a title that starts with what you typed, then each word you typed starting a word of
// the title ("api k"), the title's initials ("mr" for Mail routing), a word it answers to ("receiving"), anywhere in the
// title, and last the letters in order from the start of one of its words ("dmns" finds Domains; "key" never matches
// inside "Bakery"). Every word typed must match something.
const fold = (text: string) => text.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
const wordsOf = (text: string) => fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
const inOrder = (needle: string, hay: string) => { let at = 0; for (const letter of needle) { at = hay.indexOf(letter, at) + 1; if (!at) return false } return true }
const letter = /[\p{L}\p{N}]/u
const fuzzy = (term: string, title: string) => title.split('').some((char, at) => char === term[0] && (at === 0 || !letter.test(title[at - 1])) && inOrder(term.slice(1), title.slice(at + 1)))
function score(command: Pick<Command, 'title' | 'words'>, query: string) {
  const q = fold(query).trim(), title = fold(command.title), words = wordsOf(command.title), extra = wordsOf(command.words ?? '')
  if (!q) return 1
  if (title === q) return 1000
  if (title.startsWith(q)) return 900 - title.length
  if (q.length > 1 && !q.includes(' ') && words.map(word => word[0]).join('').startsWith(q)) return 700
  const terms = q.split(/\s+/)
  let total = 0
  for (const term of terms) {
    const best = words.some(word => word.startsWith(term)) ? 600 : extra.some(word => word.startsWith(term)) ? 450 : title.includes(term) ? 300 : fuzzy(term, title) ? 100 : 0
    if (!best) return 0
    total += best
  }
  return total / terms.length
}

export function CommandMenu({ open, onOpenChange, pages, help, signOut }: { open: boolean; onOpenChange: (open: boolean) => void; pages: readonly Command[]; help: (() => void) | null; signOut: (() => void) | null }) {
  // The title is for screen readers: the field is the menu's header.
  return <Dialog open={open} onOpenChange={onOpenChange} title="Search or jump" className="command-menu" analytics="command-menu">
    {open && <Palette close={() => onOpenChange(false)} pages={pages} help={help} signOut={signOut} />}
  </Dialog>
}

// Mounted with each opening, so it always starts from the whole list.
function Palette({ close, pages, help, signOut }: { close: () => void; pages: readonly Command[]; help: (() => void) | null; signOut: (() => void) | null }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [view, setView] = useState<'root' | 'workspaces'>('root')
  const [recent] = useState(readRecent)
  const { pathname } = useLocation()
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const term = query.trim()
  const actions = useActions({ help, signOut })
  const workspaces = useWorkspaces(view === 'workspaces' || term !== '')
  const groups = useMemo<Group[]>(() => {
    const order = (item: Command) => { const at = recent.indexOf(item.id); return at < 0 ? RECENT_KEPT : at }
    const search = (items: Command[]) => items.map(item => ({ item, score: score(item, term) })).filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || order(a.item) - order(b.item)).map(entry => entry.item)
    if (view === 'workspaces') {
      const accounts = [...new Set(workspaces.map(item => item.note))]
      if (term) return [{ label: null, items: search(workspaces) }]
      return accounts.length > 1 ? accounts.map(account => ({ label: account ?? null, items: workspaces.filter(item => item.note === account) })) : [{ label: null, items: workspaces }]
    }
    const switches = workspaces.filter(item => !item.current).map(item => ({ ...item, title: `Switch to ${item.title}`, icon: ArrowLeftRight, searchOnly: true }))
    const everything = [...pages, ...actions, ...switches]
    if (term) return [{ label: null, items: search(everything) }]
    // The page you're on isn't one to go back to.
    const shown = everything.filter(item => !item.searchOnly || recent.includes(item.id))
    const last = recent.map(item => shown.find(command => command.id === item)).filter((item): item is Command => Boolean(item) && !(item!.path && onPage(item!.path, pathname))).slice(0, RECENT_SHOWN)
    const rest = (section: Command['section']) => shown.filter(item => item.section === section && !item.searchOnly && !last.includes(item))
    return [{ label: 'Recent', items: last }, { label: 'Pages', items: rest('Pages') }, { label: 'Actions', items: rest('Actions') }].filter(group => group.items.length)
  }, [view, term, pages, actions, workspaces, recent, pathname])
  const items = groups.flatMap(group => group.items)
  const at = Math.min(active, Math.max(0, items.length - 1))
  useEffect(() => {
    if (at === 0) list.current?.scrollTo({ top: 0 })
    else list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [at, items.length, view])
  const enter = (next: 'root' | 'workspaces') => { setView(next); setQuery(''); setActive(0); input.current?.focus() }
  const run = (command: Command | undefined) => {
    if (!command) return
    if (command.opens) { enter(command.opens); return }
    if (command.current) { close(); return }
    remember(command.id)
    close()
    // A page opens at once; an action runs once the menu has closed, so a dialog or panel it opens takes focus.
    if (command.path) command.run?.()
    else setTimeout(() => command.run?.(), 0)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey
    const step = event.key === 'ArrowDown' || (ctrl && event.key === 'n') ? 1 : event.key === 'ArrowUp' || (ctrl && event.key === 'p') ? -1 : 0
    if (step) { event.preventDefault(); if (items.length) setActive((at + step + items.length) % items.length); return }
    if (event.key === 'Enter') { event.preventDefault(); run(items[at]); return }
    if (event.key === 'Backspace' && !query && view !== 'root') { event.preventDefault(); enter('root') }
  }
  let index = -1
  const option = (command: Command) => {
    const mine = ++index
    return <div key={command.id} id={`${id}-${mine}`} role="option" aria-selected={mine === at} aria-disabled={command.current || undefined} className="command-menu__item"
      data-analytics={`command/${command.personal ? 'workspace' : command.id}`} data-private={command.personal || undefined}
      onMouseMove={() => { if (mine !== at) setActive(mine) }} onClick={() => run(command)}>
      <span className="command-menu__icon" aria-hidden="true">{command.icon && <Icon icon={command.icon} size="sm" />}</span>
      <span className="command-menu__title">{command.title}{command.note && view === 'root' && <span className="command-menu__note">{command.note}</span>}</span>
      {end(command)}
    </div>
  }
  const empty = view === 'workspaces' ? 'No workspaces match' : 'Nothing matches'
  return <>
    <div className="command-menu__field">
      <Icon icon={Search} size="sm" tone="muted" />
      {view === 'workspaces' && <button type="button" className="command-menu__crumb" onClick={() => enter('root')} aria-label="Back to everything">Switch workspace</button>}
      <input ref={input} className="command-menu__input" type="text" role="combobox" aria-label={view === 'workspaces' ? 'Search workspaces' : 'Search pages and actions'} aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-list`} aria-activedescendant={items.length ? `${id}-${at}` : undefined}
        placeholder={view === 'workspaces' ? 'Search workspaces…' : 'Search pages and actions…'} autoComplete="off" spellCheck={false} value={query} onChange={event => { setQuery(event.target.value); setActive(0) }} onKeyDown={onKeyDown} />
    </div>
    <div ref={list} id={`${id}-list`} className="command-menu__list ui-scroll-fade" role="listbox" aria-label={view === 'workspaces' ? 'Workspaces' : 'Pages and actions'}>
      {groups.map((group, number) => group.label ? <div key={`${group.label}-${number}`} role="group" aria-labelledby={`${id}-g${number}`} className="command-menu__group">
        <div id={`${id}-g${number}`} role="presentation" className="command-menu__section" data-private={view === 'workspaces' || undefined}>{group.label}</div>
        {group.items.map(option)}
      </div> : <div key={number} role="presentation" className="command-menu__group">{group.items.map(option)}</div>)}
      {!items.length && <div className="command-menu__empty" role="presentation">{term ? <>{empty} “{term}”</> : 'No workspaces'}</div>}
    </div>
    <div className="command-menu__foot" aria-hidden="true">
      <span><kbd className="ui-kbd">↑</kbd><kbd className="ui-kbd">↓</kbd>Move</span>
      <span><kbd className="ui-kbd"><Icon icon={CornerDownLeft} size="xs" /></kbd>Open</span>
      {view !== 'root' && <span><kbd className="ui-kbd">⌫</kbd>Back</span>}
      <span><kbd className="ui-kbd">Esc</kbd>Close</span>
    </div>
  </>
}

function end(command: Command): ReactNode {
  if (command.locked) return <Icon icon={Lock} size="xs" tone="faint" label="Owners and admins only" />
  if (command.current) return <Icon icon={Check} size="sm" label="Current workspace" />
  if (command.opens) return <Icon icon={ChevronRight} size="sm" tone="faint" />
  if (command.shortcut) return <span className="command-menu__keys" aria-label={`Shortcut ${command.shortcut.label}`}>{command.shortcut.keys.map(key => <kbd key={key} className="ui-kbd">{key}</kbd>)}</span>
  return null
}
const onPage = (path: string, pathname: string) => pathname === path || pathname.startsWith(`${path}/`)

// What you can do from anywhere, for the people who can: members don't manage keys or domains (the API enforces this too).
function useActions({ help, signOut }: { help: (() => void) | null; signOut: (() => void) | null }): Command[] {
  const navigate = useNavigate(), toast = useToast(), api = useApi(), client = useQueryClient()
  const { theme, toggleTheme } = useTheme()
  const privacy = usePrivacy()
  const identity = useSession()?.identity
  const mail = useMailServers() !== null
  const { canAdminister, multiTenant } = useWorkspaceAccess()
  return useMemo(() => {
    // A test email from the workspace's own verified domain (else its built-in one) to the signed-in person, as
    // Overview's first-send card sends it (POST /v1/domains/{id}/test-send); it shows in Logs.
    async function sendTest() {
      try {
        const sendingDomains = queries.sendingDomains()
        const items = await client.fetchQuery({ queryKey: ['nightmail', ...sendingDomains.key], queryFn: ({ signal }) => sendingDomains.read(api, signal), staleTime: 30_000 })
        const domain = preferredSendingDomain(items, { allowBuiltIn: true })
        if (!domain) { toast('Add and verify a domain to send a test email.', 'error', { action: { label: 'Domains', onSelect: () => navigate('/domains') } }); return }
        const sent = await request<{ id: string }>(`/v1/domains/${encodeURIComponent(domain.id)}/test-send`, { method: 'POST', idempotencyKey: crypto.randomUUID() })
        void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && ['overview', 'overview-setup', 'logs', 'emails', 'sender-score', 'sending-limit'].includes(resourceOf(query.queryKey)) }).catch(() => {})
        toast(`Test email queued, from ${domain.name} to your own address.`, 'success', { action: { label: 'View', onSelect: () => navigate(`/logs/${encodeURIComponent(sent.id)}`) } })
      } catch (error) { if (!isAbortError(error)) toast(errorText(error, 'Couldn’t send the test email.'), 'error') }
    }
    const action = (command: Omit<Command, 'section'>): Command => ({ ...command, section: 'Actions' })
    return [
      action({ id: 'connect-agent', title: 'Connect your agent', icon: Bot, words: 'mcp ai claude cursor codex opencode chatgpt', run: openConnectAgent }),
      ...canAdminister ? [
        action({ id: 'new-api-key', title: 'New API key', icon: KeyRound, words: 'create token secret', run: () => navigate('/api-keys?create=send') }),
        // SMTP & IMAP: the server, port and username an app or a mail app needs, each section of its own page.
        ...mail ? [action({ id: 'smtp-settings', title: 'SMTP settings', icon: Server, words: 'server port host username login relay', run: () => navigate('/smtp-imap#smtp') }),
          action({ id: 'imap-settings', title: 'IMAP settings', icon: Mail, words: 'mail app server port host username app password', run: () => navigate('/smtp-imap#imap') })] : [],
        action({ id: 'add-domain', title: 'Add domain', icon: Globe, words: 'new dns verify', run: () => navigate('/domains?add') }),
        ...identity?.email ? [action({ id: 'test-email', title: 'Send a test email', icon: Send, words: 'try first yourself', run: () => void sendTest() })] : [],
      ] : [],
      ...help ? [action({ id: 'help', title: 'Help', icon: MessageCircleQuestionMark, words: 'support chat question contact', run: help })] : [],
      action({ id: 'theme', title: theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', icon: theme === 'dark' ? Sun : Moon, words: 'theme appearance dark light', run: toggleTheme }),
      action({ id: 'privacy', title: privacy ? 'Show email addresses' : 'Blur email addresses', icon: privacy ? Eye : EyeOff, words: 'privacy hide mask', shortcut: { keys: ['⇧', 'P'], label: 'Shift+P' }, run: togglePrivacy }),
      ...multiTenant && identity ? [action({ id: 'switch-workspace', title: 'Switch workspace', icon: ArrowLeftRight, words: 'account change team', opens: 'workspaces' })] : [],
      ...signOut ? [action({ id: 'sign-out', title: 'Sign out', icon: LogOut, words: 'log out logout', run: signOut })] : [],
    ]
  }, [api, client, navigate, toast, theme, toggleTheme, privacy, identity, mail, canAdminister, multiTenant, help, signOut])
}

// Hosted: every workspace of the accounts this browser connected, as the account menu lists them (the tab's own account
// comes with the session; the others are read once the list or a search needs them).
function useWorkspaces(load: boolean): Command[] {
  const session = useSession(), toast = useToast(), identity = session?.identity
  const multiTenant = identity?.multiTenant === true
  const accounts = useAccounts(load && multiTenant)
  return useMemo(() => {
    if (!session || !identity || !multiTenant) return []
    const self = { id: identity.id, name: identity.name ?? '', email: identity.email, workspaces: identity.workspaces ?? [] }
    const all = withOwnAccount(self, accounts.data)
    const switchTo = (account: string, workspace: string) => void (account === self.id ? session.switchWorkspace(workspace, sectionPath()) : session.switchAccount(account, sectionPath(), workspace))
      .catch(error => { if (!isAbortError(error)) toast(errorText(error, 'Couldn’t switch workspace.'), 'error') })
    return all.flatMap(account => account.workspaces.map(workspace => ({
      id: `workspace-${account.id}-${workspace.id}`, title: workspace.name, icon: null, section: 'Actions' as const, personal: true,
      note: all.length > 1 ? account.name || account.email || 'Account' : undefined, current: account.id === self.id && workspace.id === identity.workspaceId,
      run: () => switchTo(account.id, workspace.id),
    })))
  }, [session, identity, multiTenant, accounts.data, toast])
}
