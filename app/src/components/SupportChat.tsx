import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { ChevronDown, MessageCircleQuestionMark } from 'lucide-react'
import { chunk } from '../lib/preloadable'
import { usePhone } from '../lib/media'
import { IconButton } from './ui'

// The support chat's Help button and the panel's host, in the dashboard shell (AppShell). The panel's code loads once the
// page is idle (hover, focus or press warms it sooner); the conversation and its transport start when Help opens.
//
// Where it runs: ?support=demo (kept for the browser session; ?support=off clears it) get the
// scripted demo conversation. Hosted workspaces get the live support Worker by the build's VITE_SUPPORT_CHAT: "true" for
// everyone (dev deploys), "staff" for Nightmail staff (the operator role) and workspaces Anomaly made free, unset for no one
// (production until it is rolled out). ?support=<conversationId> opens the panel on that chat conversation; an email
// conversation continues on /support/continue/<id> instead (support emails link there), and the panel sends it there.
const panel = chunk(() => import('../features/support'))
const Panel = panel.page(module => module.SupportPanel)
const modeKey = 'nightmail.support'
export type SupportMode = 'demo' | 'live'

function readMode(hosted: boolean, staff: boolean) {
  const param = new URLSearchParams(window.location.search).get('support')
  try {
    if (param === 'demo') sessionStorage.setItem(modeKey, 'demo')
    if (param === 'off') sessionStorage.removeItem(modeKey)
  } catch { /* Session storage is unavailable: the parameter still applies to this load. */ }
  let stored: string | null = null
  try { stored = sessionStorage.getItem(modeKey) } catch { stored = param === 'demo' ? 'demo' : null }
  const flag = import.meta.env.VITE_SUPPORT_CHAT as string | undefined
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
  return <Panel mode={chat.mode} resume={chat.resume} open={chat.open} onClose={() => chat.setOpen(false)} onUnread={chat.setUnread} />
}
