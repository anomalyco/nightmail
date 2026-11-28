import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu'
import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, LogOut, MessageCircleQuestionMark, Plus, StickyNote, UserPlus } from 'lucide-react'
import { sectionPath, useApiMutation, useSession } from '../data/context'
import { isAbortError } from '../data/live'
import { accountApi, accountsKey, initials, useAccounts, withOwnAccount, type ConnectedAccount } from '../data/accounts'
import { useMembershipCache, workspaceApi } from '../data/workspaces'
import { usePhone } from '../lib/media'
import { PrivateAddress } from './PrivateAddress'
import { Button, Dialog, Field, Input, Sheet, useToast, fieldError, MutationError } from './ui'
import { toggleUiNotesMode, useUiNotesMode } from '../lib/ui-notes-mode'
import { errorText } from '../data/types'

// One menu for who and where: the accounts this browser connected, each with its workspaces, then Add account and Sign
// out, which stay in view below the list however long it gets. Picking a workspace of another account switches account
// and workspace together. Multi-tenant only; shown in the dashboard sidebar, the phone's top bar (as a sheet) and the
// onboarding header, which alone adds Help (`help` opens the support chat): in the dashboard Help is in the sidebar and More.
type Entry = { key: string; label: ReactNode; text: string; icon?: ReactNode; checked?: boolean; disabled?: boolean; destructive?: boolean; heading?: boolean; onSelect: () => void }
export function AccountAvatar({ name, email, size = 'md' }: { name: string | null | undefined; email?: string | null; size?: 'sm' | 'md' }) {
  return <span className={`account-avatar account-avatar--${size}`} aria-hidden="true">{initials(name, email)}</span>
}
function Who({ account }: { account: Pick<ConnectedAccount, 'name' | 'email'> }) {
  return <span className="account-menu__who"><span className="account-menu__name">{account.name || account.email || 'Account'}</span>{account.email && <PrivateAddress className="account-menu__email" value={account.email} />}</span>
}
export function AccountSwitcher({ help = null }: { help?: (() => void) | null } = {}) {
  const session = useSession()
  const toast = useToast()
  const phone = usePhone()
  const client = useQueryClient()
  const memberships = useMembershipCache()
  const identity = session?.identity
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Help leaves focus to the chat it opens: the menu doesn't hand it back to its trigger as it closes.
  const helping = useRef(false)
  const list = useAccounts(open)
  // The menu itself takes focus when it opens, and an address reveals while focus is on anything that holds it: focus
  // the current workspace instead, so the account's address stays masked until its own row is pointed at or highlighted.
  useEffect(() => {
    if (!open || phone) return
    const frame = requestAnimationFrame(() => {
      const menu = document.querySelector<HTMLElement>('.account-menu')
      menu?.querySelector<HTMLElement>('[role="menuitem"]:has(.account-menu__check)')?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, phone])
  const notesOn = useUiNotesMode(identity?.uiNotes === true)
  const load = () => client.fetchQuery({ queryKey: accountsKey, queryFn: ({ signal }) => accountApi.list(signal), staleTime: 30_000 })
  const intent = () => { void load().catch(() => {}) }
  // The phone's sheet is anchored to the bottom of the screen and would grow upwards when the list arrived, so it opens
  // with the list already there (it is usually warm from the touch that started the tap).
  async function openSheet() {
    if (busy) return
    setBusy(true)
    try { await load() } catch { /* The sheet still opens with this tab's account. */ } finally { setBusy(false) }
    setOpen(true)
  }
  if (!identity) return null
  const self: ConnectedAccount = { id: identity.id, name: identity.name ?? '', email: identity.email, workspaces: identity.workspaces ?? [] }
  const accounts = withOwnAccount(self, list.data)
  const limit = list.data?.limit ?? 5
  const workspace = self.workspaces.find(item => item.id === identity.workspaceId)
  async function run(action: () => Promise<void> | void, failure: string) {
    setOpen(false); setBusy(true)
    try { await action() } catch (error) { if (isAbortError(error)) return; toast(errorText(error, failure), 'error'); void memberships.refresh() } finally { setBusy(false) }
  }
  const oneWorkspace = identity.canCreateWorkspace === false
  const sections: Entry[][] = accounts.map(account => {
    const active = account.id === self.id
    return [
      { key: `account:${account.id}`, heading: true, label: <><AccountAvatar name={account.name} email={account.email} /><Who account={account} /></>, text: account.name || account.email || 'Account',
        disabled: active, onSelect: () => void run(() => session!.switchAccount(account.id, sectionPath()), 'Couldn’t switch account.') },
      ...account.workspaces.map(item => ({ key: `workspace:${account.id}:${item.id}`, text: item.name, label: <span className="account-menu__workspace-name">{item.name}</span>,
        checked: active && item.id === identity.workspaceId,
        onSelect: () => void run(() => active ? session!.switchWorkspace(item.id, sectionPath()) : session!.switchAccount(account.id, sectionPath(), item.id), 'Couldn’t switch workspace.') })),
      // Hosted, only staff can create more workspaces for now (GET /v1/me canCreateWorkspace): nobody else is offered it.
      ...active && !oneWorkspace ? [{ key: 'new-workspace', text: 'New workspace…', label: 'New workspace…', icon: <Plus />, onSelect: () => { setOpen(false); setCreating(true) } }] : [],
    ]
  })
  const full = accounts.length >= limit
  sections.push([
    // Nightmail staff: UI notes mode, for leaving design and bug notes on the dashboard (⇧N anywhere).
    ...identity.uiNotes === true ? [{ key: 'ui-notes', text: `UI notes ${notesOn ? 'on' : 'off'}`, icon: <StickyNote />, onSelect: () => { setOpen(false); toggleUiNotesMode() },
      label: <span className="account-menu__toggle">UI notes<span className="account-menu__toggle-state">{notesOn ? 'On' : 'Off'}{!phone && <kbd>⇧N</kbd>}</span></span> }] : [],
    ...help ? [{ key: 'help', text: 'Help', label: 'Help', icon: <MessageCircleQuestionMark />, onSelect: () => { helping.current = true; setOpen(false); help() } }] : [],
    // At the limit, Add account says why it can't, only when it is chosen.
    { key: 'add', text: 'Add account', label: 'Add account', icon: <UserPlus />, onSelect: () => { setOpen(false); if (full) toast(`Up to ${limit} accounts. Sign out of one first.`, 'error'); else session!.addAccount() } },
    { key: 'sign-out', text: 'Sign out', label: 'Sign out', icon: <LogOut />, onSelect: () => void run(() => session!.signOutAccount(self.id), 'Couldn’t sign out.') },
    ...accounts.length > 1 ? [{ key: 'sign-out-all', text: 'Sign out of all accounts', label: 'Sign out of all accounts', icon: <LogOut />, destructive: true, onSelect: () => void run(() => session!.signOutAll(), 'Couldn’t sign out.') }] : [],
  ])
  // Names and workspaces are people's data: analytics (lib/analytics.ts) records these controls by name alone.
  const named = (entry: Entry) => 'account/' + entry.key.split(':')[0]
  const trigger = <button ref={triggerRef} type="button" id="sidebar-workspace" className="ui-input ui-select-trigger account-switcher" disabled={busy} data-private data-analytics="account/switcher"
    aria-label={`${self.name || 'Account'}, ${workspace?.name ?? 'workspace'}. Switch account or workspace`} title={[workspace?.name, self.name].filter(Boolean).join(' · ')} onPointerEnter={intent} onPointerDown={intent} onFocus={intent} onClick={phone ? () => void openSheet() : undefined}>
    <AccountAvatar name={self.name} email={self.email} size="sm" />
    <span className="account-switcher__workspace">{workspace?.name ?? 'Workspace'}</span>
    <span><ChevronDown size={14} aria-hidden="true" /></span>
  </button>
  const refocus = () => requestAnimationFrame(() => document.getElementById('sidebar-workspace')?.focus())
  const create = <>
    {creating && <CreateWorkspaceDialog onClose={() => { setCreating(false); refocus() }} onCreated={id => void run(() => session!.switchWorkspace(id, '/overview'), 'Couldn’t switch workspace.')} />}
  </>
  // A phone gets a sheet: full-width rows at the bottom of the screen, in thumb reach, and Cancel.
  if (phone) return <>
    {trigger}
    <Sheet open={open} onOpenChange={setOpen} title="Accounts" className="ui-action-sheet account-sheet" returnFocus={triggerRef}>
      {sections.map((section, index) => <div key={index} className="ui-action-sheet__items" role="group" data-private>{section.map(entry =>
        <button key={entry.key} type="button" data-analytics={named(entry)} disabled={entry.disabled && !entry.heading} aria-disabled={entry.disabled || undefined} aria-current={entry.checked || (entry.heading && entry.disabled) ? 'true' : undefined}
          className={['ui-action-sheet__item', entry.heading && 'account-sheet__account', entry.destructive && 'ui-action-sheet__item--danger', !entry.heading && !entry.icon && 'account-sheet__workspace'].filter(Boolean).join(' ')}
          onClick={() => { if (entry.disabled) return; setOpen(false); setTimeout(entry.onSelect, 0) }}>
          {entry.icon && <span className="ui-menu-icon">{entry.icon}</span>}
          {entry.icon ? <span className="ui-action-sheet__label">{entry.label}</span> : entry.label}
          {entry.checked && <Check className="account-menu__check" size={16} aria-label="Current workspace" />}
        </button>)}</div>)}
      <button type="button" className="ui-action-sheet__item ui-action-sheet__cancel" onClick={() => setOpen(false)}>Cancel</button>
    </Sheet>
    {create}
  </>
  // Near the window's edge (Get started's menu, at the right) the menu keeps the header's own inset from it.
  return <>
    <DropdownPrimitive.Root open={open} onOpenChange={next => { setOpen(next); if (next) intent() }}>
      <DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal><DropdownPrimitive.Content align="start" sideOffset={4} collisionPadding={12} className="ui-popover ui-menu account-menu" aria-label="Accounts and workspaces" data-private
        onCloseAutoFocus={event => { if (helping.current) { helping.current = false; event.preventDefault() } }}>
        <div className="ui-popover-scroll">{sections.slice(0, -1).map((section, index) => <MenuGroup key={index} entries={section} named={named} />)}</div>
        <MenuGroup entries={sections[sections.length - 1]} named={named} className="account-menu__actions" />
      </DropdownPrimitive.Content></DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
    {create}
  </>
}

function MenuGroup({ entries, named, className }: { entries: Entry[]; named: (entry: Entry) => string; className?: string }) {
  return <DropdownPrimitive.Group className={['account-menu__group', className].filter(Boolean).join(' ')}>{entries.map(entry => entry.heading && entry.disabled
    ? <DropdownPrimitive.Label key={entry.key} className="ui-menu-item account-menu__account" aria-current="true">{entry.label}</DropdownPrimitive.Label>
    : <DropdownPrimitive.Item key={entry.key} disabled={entry.disabled} onSelect={entry.onSelect} data-analytics={named(entry)}
      className={['ui-menu-item', entry.heading ? 'account-menu__account' : entry.icon ? 'account-menu__action' : 'account-menu__workspace', entry.destructive && 'ui-menu-item--danger'].filter(Boolean).join(' ')}>
      {entry.icon && <span className="ui-menu-icon">{entry.icon}</span>}{entry.label}{entry.checked && <Check className="account-menu__check" size={14} aria-label="Current workspace" />}
    </DropdownPrimitive.Item>)}</DropdownPrimitive.Group>
}

// A new workspace starts like a new signup: switching to it opens onboarding.
function CreateWorkspaceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const create = useApiMutation((api, value: string) => workspaceApi(api.scope).create(value), undefined, false, false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    try { const workspace = await create.mutateAsync(name.trim()); onClose(); onCreated(workspace.id) } catch { /* inline */ }
  }
  return <Dialog open onOpenChange={open => { if (!open && !create.isPending) onClose() }} title="Create workspace"
    footer={<><Button onClick={onClose} disabled={create.isPending}>Cancel</Button><Button type="submit" form="create-workspace" variant="primary" loading={create.isPending}>Create workspace</Button></>}>
    <form id="create-workspace" className="stack" onSubmit={submit}>
      <MutationError error={create.error} />
      <Field label="Name" htmlFor="create-workspace-name" error={fieldError(create.error, 'name')}><Input id="create-workspace-name" maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={create.isPending} autoFocus required /></Field>
    </form>
  </Dialog>
}
