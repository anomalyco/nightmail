import { lazy, use, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useSearchParams } from 'react-router'
import { ThemeToggle } from '../../components/ThemeToggle'
import { NightmailWordmark } from '../../components/NightmailLogo'
import { EmptyState } from '../../components/ui'
import { productName } from '../../../../api/src/brand'
import { PRICE_PAGES } from './pages'
import { comparisons } from './compare'
import { SceneFrame } from './frame'
import './pricing.css'

// The price pages' scene, its styles and its pictures are a module of their own (board-page.tsx), loaded only here.
const boardPage = () => import('./board-page')
const PriceScene = lazy(() => boardPage().then(m => ({ default: m.PriceScene })))
const BoardEnd = lazy(() => boardPage().then(m => ({ default: m.BoardEnd })))
// A vendor's pricing page (/pricing/<vendor>, docs/) is a module of its own too, in a build that has them: live.ts's
// PRICE_PAGES_VERDICT, read here as the literal vite.config.ts writes for it, because only a literal at the import
// drops the module from a build without them.
const docPage = __NIGHTMAIL_PRICE_PAGES__ ? () => import('./docs/doc-page') : () => Promise.reject(new Error('No pricing pages in this build.'))
const DocPageScene = lazy(() => docPage().then(m => ({ default: m.DocPageScene })))
const DocEnd = lazy(() => docPage().then(m => ({ default: m.DocEnd })))

// Public pages, no sign-in: the price calculator (/pricing), one comparison per competitor (/compare/:vendor) and a
// pricing page for some of them (/pricing/:vendor, docs/), linked from the homepage's footer and from each other (live.ts).

// Prose here uses proportional figures, and the local fallback faces are sized for the tabular ones (tokens.css): text
// painted before the web fonts arrive rewraps when they do. So the pages wait for them, as long as 3 seconds.
const fontsReady = Promise.race([
  Promise.all(['400 16px Inter', '700 16px "OpenTUI Mono"', '400 16px "OpenTUI Mono"'].map(font => document.fonts.load(font, 'a1'))),
  new Promise(resolve => setTimeout(resolve, 3000)),
]).catch(() => {})

const pageLinks = (label: (page: (typeof PRICE_PAGES)[number]) => string) => PRICE_PAGES.filter(page => !page.doc).map(page => <NavLink key={page.path} to={page.path} end>{label(page)}</NavLink>)

/** The page each price page's own file paints before this code (app/price-pages.ts, #price-shell: the same scene, over
 *  this one until now, with its CSS). It goes as this page is first drawn, in the same frame and at the same place, so
 *  nothing moves; the reader's scroll stays, their focus moves to the same control here, what they typed or slid on it
 *  is set here, and a button they pressed while this code loaded (home/shell/boot.js holds it) is pressed here.
 *  Whether there was one. */
function useShellTakeover() {
  const [painted] = useRef([typeof document !== 'undefined' && document.getElementById('price-shell') !== null]).current
  const carried = useRef<{ typed: (string | null)[]; pressed: Place | null } | null>(null)
  useLayoutEffect(() => {
    const shell = document.getElementById('price-shell')
    if (!shell) return
    const focused = placeOf(shell, document.activeElement)
    const held = window as Window & { __nightmailShellPress?: Element }
    carried.current = { typed: [...shell.querySelectorAll('input')].map(input => input.value !== input.defaultValue ? input.value : null), pressed: placeOf(shell, held.__nightmailShellPress) }
    delete held.__nightmailShellPress
    shell.remove()
    document.querySelector('style[data-shell-css]')?.remove()
    atPlace(document.querySelector('#root .price-page'), focused)?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    const was = carried.current, page = document.querySelector('#root .price-page')
    if (!was || !page) return
    const inputs = [...page.querySelectorAll('input')], setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    was.typed.forEach((value, i) => { const input = inputs[i]; if (value !== null && input) { setValue.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) } })
    atPlace(page, was.pressed)?.click()
  }, [])
  return painted
}
const controls = (root: ParentNode | null) => [...root?.querySelectorAll<HTMLElement>('a[href], button, input') ?? []]
// A control's place, the same on the painted page and the app's: which of the controls with its class it is (Get started
// and the Open dashboard drawn in its place for someone signed in share theirs), or for one without a class, of those
// with its tag, address and words. Not its place among all controls: signed in, the app's page has no sign-in consent
// and its links, so every control after them would be another one, pressed or focused in the reader's place.
type Place = { key: string; nth: number }
const keyOf = (control: HTMLElement) => control.className ? `.${control.className}` : `${control.tagName}|${control.getAttribute('href') ?? ''}|${control.textContent?.trim() ?? ''}`
function placeOf(root: ParentNode | null, control: Element | null | undefined): Place | null {
  const all = controls(root), at = all.indexOf(control as HTMLElement)
  if (at < 0) return null
  const key = keyOf(all[at]!)
  return { key, nth: all.slice(0, at).filter(other => keyOf(other) === key).length }
}
const atPlace = (root: ParentNode | null, place: Place | null) => place ? controls(root).filter(control => keyOf(control) === place.key)[place.nth] : undefined

/** A price page's frame: a scene (frame.tsx), or for a comparison that doesn't exist, a bar along the top (the
 *  wordmark, the price pages and the theme) over one plain column. title: the tab's whole title. */
function PriceFrame({ title, children, end, scene }: { title: string; children: ReactNode; end?: ReactNode; scene?: boolean }) {
  use(fontsReady)
  useEffect(() => { document.title = title }, [title])
  // A page opens at its top, unless it takes over from the painted one, which the reader may have scrolled.
  const painted = useShellTakeover(), opened = useRef(false)
  useLayoutEffect(() => { if (opened.current || !painted) window.scrollTo(0, 0); opened.current = true }, [title, painted])
  if (scene) return <SceneFrame end={end}>{children}</SceneFrame>
  return <div className="price-page">
    <header className="price-header">
      <Link className="wordmark" to="/" aria-label={`${productName.toLowerCase()} home`}><NightmailWordmark /></Link>
      <nav className="price-switcher" aria-label="Price pages">{pageLinks(page => page.path === '/pricing' ? 'Calculator' : page.title.replace(`${productName} `, ''))}</nav>
      <ThemeToggle />
    </header>
    <main className="price-main" id="price-main" tabIndex={-1}>{children}</main>
    <footer className="price-footer">
      <p>Product names belong to their owners and only identify their products. {productName} isn’t affiliated with them.</p>
    </footer>
  </div>
}

/** The three price pages are one page: the hall stays as the reader moves between them (App.tsx gives both addresses
 *  this component, so it isn't drawn again) and only its board changes (scene.tsx). An unknown comparison is not found. */
export function PricePage() {
  const { pathname } = useLocation()
  const vendor = pathname.startsWith('/compare/') ? pathname.slice('/compare/'.length).replace(/\/+$/, '') : null
  const comparison = vendor !== null && Object.hasOwn(comparisons, vendor) ? comparisons[vendor]! : null
  const page = PRICE_PAGES.find(p => p.path === (vendor === null ? '/pricing' : `/compare/${vendor}`))
  // The board's frame in the homepage's steel, while its concrete waits for a yes (board.tsx): ?frame=steel.
  const [search] = useSearchParams()
  // A vendor's pricing page (/pricing/<vendor>: docs/), or not found.
  if (pathname.startsWith('/pricing/')) {
    const doc = PRICE_PAGES.find(p => p.path === pathname.replace(/\/+$/, ''))?.doc
    if (doc) return <PriceFrame title={doc.searchTitle} end={<DocEnd doc={doc} />} scene><DocPageScene doc={doc} /></PriceFrame>
  }
  if ((vendor !== null && !comparison) || pathname.startsWith('/pricing/')) return <PriceFrame title={`Page not found · ${productName.toLowerCase()}`}><EmptyState headingAs="h1" title="Page not found" action={<Link to="/pricing">Price calculator</Link>} /></PriceFrame>
  // The tab's title is the one the page's HTML carries (price-pages.ts), so search engines read one title either way.
  return <PriceFrame title={page!.searchTitle} end={<BoardEnd comparison={comparison} />} scene>
    <PriceScene comparison={comparison} frame={search.get('frame')} />
  </PriceFrame>
}
