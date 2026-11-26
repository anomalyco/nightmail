import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes, useParams } from 'react-router'
import { StaticTheme } from '../../lib/theme'
import { DocsStandalone } from './frame'
import { DocsView, operations, pageOf, type Document } from '.'

// A docs reference page as the app draws it for a visitor (the standalone frame: DocsStandalone, DocsView), as HTML:
// app/site-pages.ts paints it in the page's own file (#page-shell) before any of the app's code, which takes this one's
// place once it's up (index.tsx, useShellTakeover). Rendered in Node at build time, from the API definition the app
// fetches (api/openapi.json) and the address the build is made for (its examples name it): nothing here may need a
// browser. Rendered in both themes, which must draw the same page.
export function docsPainter(spec: Document, origin: string) {
  const all = operations(spec)
  function Page() {
    const page = pageOf(useParams()['*'] ?? '')
    const current = page.kind === 'operation' ? all.find(operation => operation.id === page.id) : undefined
    if (page.kind !== 'operation' || !current) throw new Error(`${page.kind === 'operation' ? page.id : 'This page'} isn't an operation in the API definition.`)
    return <DocsView spec={spec} all={all} page={page} missing={false} title={current.summary} site={{ origin, foreign: false }} inShell={false} pending={false} error={null} retry={() => {}} />
  }
  return (path: string) => {
    const [light, dark] = (['light', 'dark'] as const).map(theme => renderToStaticMarkup(<StaticTheme theme={theme}>
      <MemoryRouter initialEntries={[path]}><Routes><Route element={<DocsStandalone />}><Route path="docs/*" element={<Page />} /></Route></Routes></MemoryRouter>
    </StaticTheme>))
    if (light !== dark) throw new Error(`${path} isn't drawn the same in both themes.`)
    // The contents keep the open page in view, as DocsView's do from the app's first frame: boot.js scrolls them so.
    if (!light!.includes('<div class="ui-subnav__scroll">')) throw new Error(`${path} has no contents column to keep the open page in view.`)
    // The example's tabs underline the chosen one with a marker the app places by measuring it (ui/primitives.tsx, Tabs);
    // without the marker's class, the tab's own underline (ui.css) draws the same line in the same place.
    // What works before the app is up (home/shell/boot.js): the phone's page picker goes to the page picked, and a copy
    // button copies what it names, as the app's do.
    const marked = light!.replace('<div class="ui-subnav__scroll">', '<div class="ui-subnav__scroll" data-shell-reveal="[aria-current=&quot;page&quot;]">')
      .replaceAll('class="ui-tabs ui-tabs--marker"', 'class="ui-tabs"')
      .replace('<select class="ui-input ui-select-trigger ui-native-select"', '<select class="ui-input ui-select-trigger ui-native-select" data-shell-navigate=""')
      .replace(/(<button [^>]*aria-label="Copy endpoint path")/, '$1 data-shell-copy="#page-shell .docs-endpoint code"')
      .replace(/(<button [^>]*aria-label="Copy code example")/, '$1 data-shell-copy="#page-shell .docs-example-panels pre[data-active] code"')
    if (!marked.includes('data-shell-navigate') || (marked.includes('aria-label="Copy endpoint path"') && !marked.includes('.docs-endpoint code"'))) throw new Error(`${path}'s picker or copy button isn't drawn as prerender.tsx expects.`)
    return marked
  }
}
