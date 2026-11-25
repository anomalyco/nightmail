import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { CornerDownLeft, Lock, Search, type LucideIcon } from 'lucide-react'
import { Dialog, Icon } from './ui'

// The command bar's quick jumper (⌘K): every page of the shell, filtered as you type, with its G shortcut. Arrow keys
// move, Enter opens, Escape closes. It only navigates: every action stays on its page.
export type Command = { path: string; title: string; group: string; icon: LucideIcon | null; keys?: string; locked?: boolean }
export function CommandMenu({ open, onOpenChange, commands }: { open: boolean; onOpenChange: (open: boolean) => void; commands: readonly Command[] }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  const id = useId()
  const shown = useMemo(() => {
    const term = query.trim().toLowerCase()
    return term ? commands.filter(command => `${command.title} ${command.group} ${command.path}`.toLowerCase().includes(term)) : commands
  }, [commands, query])
  const at = Math.min(active, Math.max(0, shown.length - 1))
  // Every opening starts from the whole list, however the last one closed (Escape, ⌘K again, a pick).
  useEffect(() => { if (open) { setQuery(''); setActive(0) } }, [open])
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [at, shown])
  const go = (command: Command | undefined) => { if (!command) return; onOpenChange(false); navigate(command.path) }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step) { event.preventDefault(); if (shown.length) setActive((at + step + shown.length) % shown.length); return }
    if (event.key === 'Enter') { event.preventDefault(); go(shown[at]) }
  }
  const foot = <div className="command-menu__foot" aria-hidden="true"><span><kbd className="ui-kbd">↑</kbd><kbd className="ui-kbd">↓</kbd>Move</span><span><kbd className="ui-kbd"><Icon icon={CornerDownLeft} size="xs" /></kbd>Open</span><span><kbd className="ui-kbd">Esc</kbd>Close</span></div>
  return <Dialog open={open} onOpenChange={onOpenChange} title="Jump to" className="command-menu" analytics="command-menu" footer={foot}>
    <div className="command-menu__field">
      <Icon icon={Search} size="sm" tone="muted" />
      <input className="command-menu__input" type="text" role="combobox" aria-label="Search pages" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={shown.length ? `${id}-${at}` : undefined}
        placeholder="Search or jump…" autoComplete="off" spellCheck={false} value={query} onChange={event => { setQuery(event.target.value); setActive(0) }} onKeyDown={onKeyDown} />
    </div>
    <ul ref={list} id={`${id}-list`} className="command-menu__list" role="listbox" aria-label="Pages">
      {shown.map((command, index) => <li key={command.path} id={`${id}-${index}`} role="option" aria-selected={index === at} className="command-menu__item" onMouseMove={() => { if (index !== at) setActive(index) }} onClick={() => go(command)}>
        <span className="command-menu__icon" aria-hidden="true">{command.icon && <Icon icon={command.icon} size="sm" />}</span>
        <span className="command-menu__title">{command.title}</span>
        <span className="command-menu__group">{command.group}</span>
        {command.locked ? <Icon icon={Lock} size="xs" tone="faint" label="Owners and admins only" /> : command.keys ? <span className="command-menu__keys" aria-label={`Shortcut G then ${command.keys}`}><kbd className="ui-kbd">G</kbd><kbd className="ui-kbd">{command.keys}</kbd></span> : null}
      </li>)}
      {!shown.length && <li className="command-menu__empty" role="presentation">No pages match “{query.trim()}”</li>}
    </ul>
  </Dialog>
}
