import { useEffect, useRef, type ReactNode } from 'react'

// Onboarding is keyboard-first: Enter continues, ⌘/Ctrl+Enter sends, Esc skips, a number picks an option. Each control
// that has a key shows it (Kbd); touch screens, which have no keyboard to press it on, hide the hints (onboarding.css).

/** A key hint inside a control. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd" aria-hidden="true">{children}</kbd>
}

const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
const control = (target: EventTarget | null) => target instanceof HTMLElement && (typing(target) || ['BUTTON', 'A', 'SUMMARY'].includes(target.tagName) || target.getAttribute('role') === 'button')

/**
 * The step's keys while it is up. Enter is left to a focused field, button or link (they have their own); Esc in a field
 * leaves the field first; ⌘/Ctrl+Enter works anywhere. Nothing runs while a dialog or menu is open over the page.
 */
export function useStepKeys(keys: { enter?: () => void; modEnter?: () => void; escape?: () => void; digit?: (n: number) => void }, enabled = true) {
  const latest = useRef(keys)
  latest.current = keys
  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      const { enter, modEnter, escape, digit } = latest.current
      const mod = event.metaKey || event.ctrlKey
      if (event.key === 'Enter' && mod) { if (modEnter) { event.preventDefault(); modEnter() } return }
      if (mod || event.shiftKey) return
      if (event.key === 'Escape') {
        if (typing(event.target)) { (event.target as HTMLElement).blur(); event.preventDefault(); return }
        if (escape) { event.preventDefault(); escape() }
        return
      }
      if (event.key === 'Enter') { if (enter && !control(event.target)) { event.preventDefault(); enter() } return }
      if (digit && /^[1-9]$/.test(event.key) && !typing(event.target)) { event.preventDefault(); digit(Number(event.key)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}
