import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { GetStartedButton } from '../home/get-started'
import type { Start } from './board'
import { DocEnd, DocScene } from './docs/page'
import { SceneFrame } from './frame'
import type { PricePage } from './pages'
import { BoardEnd, Scene } from './scene'

// A price page as the app first draws it, as HTML (app/price-pages.ts puts it in the page's own file): its scene, with
// Get started as a visitor sees it, painted before any of the app's code (shell/boot.js starts that, and index.tsx's
// page takes this one's place once it's up). Rendered in Node at build time: nothing here may need a browser.
const visitor: Start = { signedIn: false, button: className => <GetStartedButton className={className} /> }
export function renderShell(page: Pick<PricePage, 'path' | 'comparison' | 'doc'>): string {
  if (page.doc) return renderToStaticMarkup(<MemoryRouter initialEntries={[page.path]}>
    <SceneFrame end={<DocEnd doc={page.doc} />}><DocScene doc={page.doc} start={visitor} /></SceneFrame>
  </MemoryRouter>)
  return renderToStaticMarkup(<MemoryRouter initialEntries={[page.path]}>
    <SceneFrame end={<BoardEnd comparison={page.comparison} />}><Scene comparison={page.comparison} start={visitor} /></SceneFrame>
  </MemoryRouter>)
}
