import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { ChevronDown, MessageCircleQuestionMark, X } from 'lucide-react'
import { chunk } from '../lib/preloadable'
import { usePhone } from '../lib/media'
import { Button, IconButton } from './ui'
import { NightmailMark } from './NightmailLogo'
import { productName } from '../../../api/src/brand'

// The support chat's Help button and the panel's host, in the dashboard shell (AppShell). The panel's code loads once the
// page is idle (hover, focus or press warms it sooner); the conversation and its transport start when Help opens.
//
// Where it runs: ?support=demo (kept for the browser session; ?support=off clears it) get the
// scripted demo conversation. Hosted workspaces get the live support Worker by the build's VITE_SUPPORT_CHAT: "true" for
// everyone (dev deploys), "staff" for Nightmail staff (the operator role) and workspaces Anomaly made free, unset for no one
// (production until it is rolled out). ?support=<conversationId> opens the panel on that chat conversation; an email
// conversation continues by email, so Help opens a conversation of its own instead.
const panel = chunk(() => import('../features/support'))
const Panel = panel.page(module => module.SupportPanel)
const modeKey = 'nightmail.support'
export type SupportMode = 'demo' | 'live'
export type PendingSupportOpen = { message?: string; shareContent?: boolean }

let pendingOpen: PendingSupportOpen | null = null
let activeOpener: (() => void) | null = null

/** Opens the in-dashboard Help panel when support chat is enabled for this session; returns false otherwise. */
export function openSupportChat(detail?: PendingSupportOpen): boolean {
  if (!activeOpener) return false
  if (detail?.message || detail?.shareContent) pendingOpen = detail
  activeOpener()
  window.dispatchEvent(new CustomEvent('nightmail:support-handoff'))
  return true
}

/** Consumes any message/content-sharing request queued by openSupportChat(). */
export function consumePendingSupportOpen(): PendingSupportOpen | null {
  const next = pendingOpen
  pendingOpen = null
  return next
}

function readMode(hosted: boolean, staff: boolean) {
  const param = new URLSearchParams(window.location.search).get('support')
  const flag = import.meta.env.VITE_SUPPORT_CHAT as string | undefined
  const demoAllowed = import.meta.env.DEV || flag === 'true' || staff
  try {
    if (param === 'demo' && demoAllowed) sessionStorage.setItem(modeKey, 'demo')
    if (param === 'off' || !demoAllowed) sessionStorage.removeItem(modeKey)
  } catch { /* Session storage is unavailable: the parameter still applies to this load. */ }
  let stored: string | null = null
  try { stored = demoAllowed ? sessionStorage.getItem(modeKey) : null } catch { stored = demoAllowed && param === 'demo' ? 'demo' : null }
  const live = hosted && (flag === 'true' || flag === 'staff' && staff)
  const mode: SupportMode | null = stored === 'demo' ? 'demo' : live ? 'live' : null
  return { mode, resume: mode === 'live' && param?.startsWith('conv_') ? param : null }
}

export type SupportChat = ReturnType<typeof useSupportChat>
export function useSupportChat({ hosted, staff }: { hosted: boolean; staff: boolean }) {
  const [{ mode, resume }] = useState(() => readMode(hosted, staff))
  const [open, setOpen] = useState(Boolean(resume))
  const [used, setUsed] = useState(Boolean(resume))
  const [unread, setUnread] = useState(false)
  useEffect(() => {
    if (!mode) return
    const openPanel = () => { setUsed(true); setOpen(true) }
    activeOpener = openPanel
    return () => { if (activeOpener === openPanel) activeOpener = null }
  }, [mode])
  // The panel's code loads when the page is idle, so Help opens at once even on a first tap (a touch has no hover).
  useEffect(() => {
    if (!mode) return
    const load = () => { void panel.preload().catch(() => {}) }
    if (typeof requestIdleCallback === 'function') { const idle = requestIdleCallback(load, { timeout: 5000 }); return () => cancelIdleCallback(idle) }
    const timer = setTimeout(load, 2000)
    return () => clearTimeout(timer)
  }, [mode])
  return { mode, resume, open, used, unread, setUnread, preload: () => { void panel.preload().catch(() => {}) },
    setOpen: (next: boolean) => { if (next) setUsed(true); setOpen(next) } }
}

// Help: on a desktop a small raised button in the page's bottom-right corner (floating), whose icon turns into a chevron
// while the chat is open above it; in the top bar on a phone or tablet.
export function SupportTrigger({ chat, floating = false }: { chat: SupportChat; floating?: boolean }) {
  const label = chat.open ? 'Close help' : chat.unread ? 'Help (new reply)' : 'Help'
  return <IconButton id="support-trigger" className={floating ? 'support-trigger support-launcher' : 'support-trigger'} variant={floating ? 'secondary' : 'ghost'} size="sm" label={label}
    aria-haspopup="dialog" aria-expanded={chat.open} aria-controls={chat.used ? 'support-panel' : undefined} data-unread={chat.unread || undefined}
    onPointerEnter={chat.preload} onFocus={chat.preload} onPointerDown={chat.preload} onClick={() => chat.setOpen(!chat.open)}>
    {floating ? <span className="support-launcher__icons" aria-hidden="true"><MessageCircleQuestionMark size={16} /><ChevronDown size={16} /></span> : <MessageCircleQuestionMark size={16} />}
  </IconButton>
}

export function SupportHost({ chat }: { chat: SupportChat }) {
  const { pathname } = useLocation()
  const phone = usePhone()
  // On a phone the sheet covers the page, so going to another page closes it; the conversation stays for next time.
  const page = useRef(pathname)
  useEffect(() => { if (page.current !== pathname) { page.current = pathname; if (phone) chat.setOpen(false) } }, [pathname, phone])
  // Escape also closes it from the page (the panel handles its own), unless focus is in a field or something else that
  // Escape belongs to: an open dialog, menu or picker.
  useEffect(() => {
    if (!chat.open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const focused = document.activeElement
      if (focused?.closest('#support-panel, input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return
      chat.setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [chat.open])
  if (!chat.mode || !chat.used) return null
  return <SupportErrorBoundary open={chat.open} phone={phone} onClose={() => chat.setOpen(false)}>
    {attempt => <Panel key={attempt} mode={chat.mode!} resume={chat.resume} open={chat.open} onClose={() => chat.setOpen(false)} onUnread={chat.setUnread} />}
  </SupportErrorBoundary>
}

// Isolates any render or chunk failure inside the support panel so it never takes down the dashboard.
class SupportErrorBoundary extends Component<{ open: boolean; phone: boolean; onClose: () => void; children: (attempt: number) => ReactNode }, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* Contained in the panel; never bubble to AppErrorBoundary. */ }
  private retry = () => {
    window.dispatchEvent(new CustomEvent('nightmail:support-reset'))
    this.setState(s => ({ failed: false, attempt: s.attempt + 1 }))
  }
  render() {
    if (!this.state.failed) return this.props.children(this.state.attempt)
    const { open, phone, onClose } = this.props
    if (!open) return null
    return <>
      {phone && <div className="support-overlay" data-open="" aria-hidden="true" onClick={onClose} />}
      <section id="support-panel" className={phone ? 'support-panel support-panel--sheet support-panel--error' : 'support-panel support-panel--error'} role="dialog" aria-modal="false" aria-labelledby="support-title" data-open="">
        <header className="support-panel__header">
          <NightmailMark className="support-panel__mark" size={18} />
          <div className="support-panel__heading"><h2 id="support-title">{productName} Support</h2></div>
          <div className="support-panel__actions"><IconButton label="Close" onClick={onClose}><X size={16} /></IconButton></div>
        </header>
        <div className="support-error" role="alert">
          <p>Support couldn’t load.</p>
          <Button size="sm" onClick={this.retry}>Retry</Button>
        </div>
      </section>
    </>
  }
}
