import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactElement, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'

// A short explanation for a control or a fact, shown on hover or keyboard focus (a tap on a touch screen, which has no
// hover). The first waits 500 ms and fades in; while one is open or closed under 300 ms ago, the next opens at once.
// It sits above its trigger (below near the window's top), or with side="right" beside it (a vertical rail's tools), in a
// portal, so no clipping edge or scroll area cuts it. offset: the gap to the trigger.
// The text is also the trigger's accessible description, whether or not it is showing.
const DELAY = 500, WARM = 300
let openCount = 0, closedAt = -Infinity
type TriggerProps = {
  ref?: Ref<HTMLElement>; 'aria-describedby'?: string
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void; onPointerLeave?: (event: PointerEvent<HTMLElement>) => void; onPointerDown?: (event: PointerEvent<HTMLElement>) => void
  onFocus?: (event: FocusEvent<HTMLElement>) => void; onBlur?: (event: FocusEvent<HTMLElement>) => void; onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
}
// A wrapper may pass props of its own (a menu's trigger renders its child with them): they go on to the trigger.
export function Tooltip({ content, side = 'top', offset = 6, children, ...passed }: { content: ReactNode; side?: 'top' | 'right'; offset?: number; children: ReactElement<TriggerProps> } & TriggerProps & Record<string, unknown>) {
  const id = useId()
  const anchor = useRef<HTMLElement | null>(null), bubble = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState<{ instant: boolean } | null>(null)
  const [place, setPlace] = useState<{ top: number; left: number; side: 'top' | 'bottom' | 'right' } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const isOpen = useRef(false)
  const show = (now = false) => {
    window.clearTimeout(timer.current)
    if (isOpen.current) return
    const warm = openCount > 0 || performance.now() - closedAt < WARM
    if (now || warm) { isOpen.current = true; openCount++; setPlace(null); setOpen({ instant: warm }); return }
    timer.current = window.setTimeout(() => show(true), DELAY)
  }
  const hide = () => {
    window.clearTimeout(timer.current)
    if (!isOpen.current) return
    isOpen.current = false; openCount--; closedAt = performance.now()
    setOpen(null)
  }
  useEffect(() => () => { window.clearTimeout(timer.current); if (isOpen.current) { openCount--; closedAt = performance.now() } }, [])
  // Placed before it paints: centred on the trigger, kept 8 px inside the window.
  useLayoutEffect(() => {
    if (!open || !anchor.current || !bubble.current) return
    const a = anchor.current.getBoundingClientRect(), b = bubble.current.getBoundingClientRect()
    if (side === 'right') { setPlace({ top: Math.min(Math.max(8, a.top + a.height / 2 - b.height / 2), window.innerHeight - b.height - 8), left: a.right + offset, side }); return }
    const below = a.top - b.height - 8 < 8
    setPlace({ top: below ? a.bottom + offset : a.top - b.height - offset, left: Math.min(Math.max(8, a.left + a.width / 2 - b.width / 2), window.innerWidth - b.width - 8), side: below ? 'bottom' : 'top' })
  }, [open, side, offset])
  // Anything that moves the trigger closes it: a scroll anywhere, a press elsewhere, Escape.
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => { if (!anchor.current?.contains(event.target as Node)) hide() }
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') hide() }
    window.addEventListener('scroll', hide, true); window.addEventListener('resize', hide)
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true)
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true) }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const own = children.props, wrapper = passed as TriggerProps
  const ref = (node: HTMLElement | null) => {
    anchor.current = node
    for (const each of [own.ref, wrapper.ref]) {
      if (typeof each === 'function') each(node)
      else if (each && typeof each === 'object') (each as { current: HTMLElement | null }).current = node
    }
  }
  return <>
    {cloneElement(children, {
      ...passed, ref, 'aria-describedby': [own['aria-describedby'], wrapper['aria-describedby'], id].filter(Boolean).join(' '),
      onPointerEnter: event => { own.onPointerEnter?.(event); wrapper.onPointerEnter?.(event); if (event.pointerType !== 'touch') show() },
      onPointerLeave: event => { own.onPointerLeave?.(event); wrapper.onPointerLeave?.(event); if (event.pointerType !== 'touch') hide() },
      // A tap on a control does what the control does; a tap on a plain fact shows its explanation.
      onPointerDown: event => { own.onPointerDown?.(event); wrapper.onPointerDown?.(event); if (event.pointerType === 'touch' && !event.currentTarget.matches('a, button, [role="radio"], [role="tab"]')) { if (isOpen.current) hide(); else show(true) } },
      onFocus: event => { own.onFocus?.(event); wrapper.onFocus?.(event); if (event.currentTarget.matches(':focus-visible')) show() },
      onBlur: event => { own.onBlur?.(event); wrapper.onBlur?.(event); hide() },
      onKeyDown: event => { own.onKeyDown?.(event); wrapper.onKeyDown?.(event); if (event.key === 'Escape' && isOpen.current) { event.stopPropagation(); hide() } },
    })}
    <span id={id} role="tooltip" hidden>{content}</span>
    {open && createPortal(<div ref={bubble} className="ui-tooltip" aria-hidden="true" data-instant={open.instant || undefined} data-side={place?.side ?? side}
      style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: 'hidden' }}>{content}</div>, document.body)}
  </>
}
