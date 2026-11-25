import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { GetStartedButton } from '../get-started'
import { LandingPage } from './page'
import type { LandingVariant } from './variant'

// An option of the new homepage as the app first draws it for a visitor, as HTML (app/landing-pages.ts puts it in the
// option's own file): painted before any of the app's code, which takes its place once it's up (index.tsx). Rendered
// in Node at build time: nothing here may need a browser.
export function renderLanding(variant: LandingVariant): string {
  return renderToStaticMarkup(<MemoryRouter initialEntries={['/']}>
    <LandingPage variant={variant} visitor full={false} cta={className => <GetStartedButton className={className} />} />
  </MemoryRouter>)
}
