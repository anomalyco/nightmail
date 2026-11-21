import { useEffect, useState } from 'react'
import { matches, SHELL_COMPACT } from '../../lib/media'
import { blockHeight, chartVariant } from './pitch'

// How many Latest emails rows fill the main column down to the page card's bottom inset, from the window alone, so the
// route skeleton, the page and the warm-up (data/prefetch.ts) agree before anything loads. The fixed parts above the
// rows are overview.css's heights: the card's inset and padding (8 + 24 each side), the header (28 + 16), the facts (two
// rows of 40, two by two, and the hairline above them) and the chart (20 + 4 + 196) with a 20px gap between (or a pitch
// take's own block, pitch.tsx), a 20px gap, the section header (24 + 4) and the table head (30). A banner above the header (standing, billing, notice) takes its own height. The list
// ends at the card's 24px inset beside the detail column; in one column it also clears the Help button (styles/app.css,
// 56px). The compact shell (tablets and phones) scrolls the document, so it keeps seven.
const ROW = 28, FIXED = 2 * 8 + 24 + 28 + 16 + 20 + 28 + 30
export function latestRowCount() {
  if (typeof window === 'undefined' || matches(SHELL_COMPACT)) return 7
  const facts = blockHeight(chartVariant(new URLSearchParams(window.location.search).get('chart')))
  const inset = matches('(max-width: 960px)') && document.querySelector('.app-shell--support') ? 56 : 24
  const banners = [...document.querySelectorAll<HTMLElement>('.page-surface > :is(.standing-banner, .page-notice)')].reduce((sum, el) => { const style = getComputedStyle(el); return sum + el.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom) }, 0)
  return Math.min(50, Math.max(7, Math.floor((window.innerHeight - FIXED - facts - inset - banners) / ROW)))
}

// The count for this visit, read once on mount and again only after the window has been resized (debounced), so it
// never changes during a load.
export function useLatestRowCount() {
  const [count, setCount] = useState(latestRowCount)
  useEffect(() => {
    let timer = 0
    const resized = () => { window.clearTimeout(timer); timer = window.setTimeout(() => setCount(latestRowCount()), 200) }
    window.addEventListener('resize', resized)
    return () => { window.removeEventListener('resize', resized); window.clearTimeout(timer) }
  }, [])
  return count
}
