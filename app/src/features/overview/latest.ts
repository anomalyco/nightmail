import { useEffect, useState } from 'react'
import { matches, PHONE, SHELL_COMPACT } from '../../lib/media'

// How many Latest emails rows fill the main column down to the window's bottom, from the window alone, so the route
// skeleton and the page agree before anything loads. The fixed parts are overview.css's heights: the command bar (44),
// the control strip (44), the figures' wells (82), the 8px gap under them, the activity band (172), the list's header
// (32), the table head (30: its 28px bar and the split under it, ui.css) and the page's 16px bottom gutter. A notice
// above the strip (standing, billing, notice) takes its own height. The list runs to the window's bottom beside the
// rail; in one column it clears the Help button (styles/app.css, 56px). The compact shell (tablets and phones) scrolls the document, so it keeps seven, and a phone five.
const ROW = 32, FIXED = 44 + 44 + 82 + 8 + 172 + 32 + 30
/** `above`: anything else over the figures (the no-domain card), in pixels with its spacing. */
export function latestRowCount(above = 0) {
  if (typeof window === 'undefined' || matches(SHELL_COMPACT)) return typeof window !== 'undefined' && matches(PHONE) ? 5 : 7
  const inset = matches('(max-width: 960px)') && document.querySelector('.app-shell--support') ? 56 : 0
  const banners = [...document.querySelectorAll<HTMLElement>('.page-surface > :is(.standing-banner, .page-notice)')].reduce((sum, el) => { const style = getComputedStyle(el); return sum + el.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom) }, 0)
  return Math.min(50, Math.max(7, Math.floor((window.innerHeight - FIXED - inset - banners - above) / ROW)))
}

// The count for this visit, read once on mount and again only after the window has been resized (debounced), so it
// never changes during a load.
export function useLatestRowCount(above = 0) {
  const [count, setCount] = useState(() => latestRowCount(above))
  useEffect(() => {
    let timer = 0
    const resized = () => { window.clearTimeout(timer); timer = window.setTimeout(() => setCount(latestRowCount(above)), 200) }
    window.addEventListener('resize', resized)
    return () => { window.removeEventListener('resize', resized); window.clearTimeout(timer) }
  }, [above])
  return count
}

// The mail Latest emails is drawn from: the newest hundred (the API's largest page), whatever the window shows of
// them, so the failures among them can lead the list. The page and its warm-up (data/prefetch.ts) ask for the same.
// A stream scopes it to that stream's sent mail (received mail has no stream).
export const latestRequest = (regionId: string, stream: 'all' | 'transactional' | 'marketing' = 'all') =>
  stream === 'all' ? { regionId, direction: 'all' as const, page: 1, pageSize: 100 } : { regionId, direction: 'sent' as const, stream, page: 1, pageSize: 100 }
