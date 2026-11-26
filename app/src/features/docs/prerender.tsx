import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes, useParams } from 'react-router'
import { productName } from '../../../../api/src/brand'
import { VisitorData } from '../../data/context'
import { drawFor, PHONE, TOUCH } from '../../lib/media'
import { StaticTheme } from '../../lib/theme'
import { agentPrompt } from './agent-setup'
import { DocsStandalone } from './frame'
import { openApiQuery } from './openapi'
import { DocsView, legacyPath, operations, pageOf, type Document } from '.'

// A docs page (the overview, a guide, an operation's reference) as the app draws it for a signed-out visitor (the
// standalone frame: DocsStandalone, DocsView), as HTML: app/site-pages.ts paints it in the page's own file (#page-shell)
// before any of the app's code, which takes this one's place once it's up (index.tsx, useShellTakeover). Rendered in Node
// at build time, from the API definition the app fetches (api/openapi.json) and the address the build is made for (its
// examples name it), with the data contexts as a visitor's page has them (no session, no account data, no token):
// nothing here may need a browser or the API. Drawn in both themes, which must draw the same page, and for each window
// that draws it differently (a phone's picker in place of tabs), each shown by the page's CSS where it applies (MEDIA_CSS).
export function docsPainter(spec: Document, origin: string) {
  const all = operations(spec)
  function Page() {
    const page = pageOf(useParams()['*'] ?? '')
    const current = page.kind === 'operation' ? all.find(operation => operation.id === page.id) : undefined
    if (page.kind === 'missing' || (page.kind === 'operation' && !current)) throw new Error('This page isn\u2019t in the docs.')
    const title = page.kind === 'guide' ? page.guide.title : current?.summary ?? `${productName} API`
    return <DocsView spec={spec} all={all} page={page} missing={false} title={title} site={{ origin, foreign: false }} inShell={false} pending={false} error={null} retry={() => {}} />
  }
  const draw = (path: string, theme: 'light' | 'dark', media: Record<string, boolean>) => {
    // What the app has asked by the time it draws a visitor's page: the API definition and this installation's address.
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    client.setQueryData(openApiQuery.queryKey, spec)
    client.setQueryData(['instance-origin'], origin)
    drawFor(media)
    try {
      return renderToStaticMarkup(<QueryClientProvider client={client}><VisitorData><StaticTheme theme={theme}>
        <MemoryRouter initialEntries={[path]}><Routes><Route element={<DocsStandalone />}><Route path="docs/*" element={<Page />} /></Route></Routes></MemoryRouter>
      </StaticTheme></VisitorData></QueryClientProvider>)
    } finally { drawFor({}); client.clear() }
  }
  return (path: string) => {
    const light = draw(path, 'light', {})
    if (draw(path, 'dark', {}) !== light) throw new Error(`${path} isn't drawn the same in both themes.`)
    const html = withMedia([['wide', light], ['phone-touch', draw(path, 'light', { [PHONE]: true, [TOUCH]: true })], ['phone-fine', draw(path, 'light', { [PHONE]: true })]])
    // The contents keep the open page in view, as DocsView's do from the app's first frame: boot.js scrolls them so.
    if (!html.includes('<div class="ui-subnav__scroll">')) throw new Error(`${path} has no contents column to keep the open page in view.`)
    // The overview's prompt for an agent is a visitor's, never a member's (no setup token, no domain, no address).
    if (path === '/docs' && !textOf(html).includes(agentPrompt({ origin, domain: undefined, email: null, multiTenant: false }))) throw new Error('/docs is painted without a visitor\u2019s agent prompt.')
    // The example's tabs underline the chosen one with a marker the app places by measuring it (ui/primitives.tsx, Tabs);
    // without the marker's class, the tab's own underline (ui.css) draws the same line in the same place. The phone's page
    // picker goes to the page picked before the app is up, and a copy button copies what it shows (home/shell/boot.js).
    const marked = copies(html.replace('<div class="ui-subnav__scroll">', '<div class="ui-subnav__scroll" data-shell-reveal="[aria-current=&quot;page&quot;]">')
      .replaceAll('class="ui-tabs ui-tabs--marker"', 'class="ui-tabs"')
      .replace('<div class="ui-subnav__picker"><select class="ui-input ui-select-trigger ui-native-select"', '<div class="ui-subnav__picker"><select class="ui-input ui-select-trigger ui-native-select" data-shell-navigate=""'), path)
    if (!marked.includes('data-shell-navigate')) throw new Error(`${path}'s page picker isn't drawn as prerender.tsx expects.`)
    // The overview's own sections (its elements' ids) are the hashes theme.js lets it paint: none may be one the app moves
    // elsewhere (legacyPath, which alone says which those are), or that old address would get the overview.
    const anchors = [...new Set([...marked.matchAll(/ id="([^"]+)"/g)].map(match => match[1]!))]
    const moved = path === '/docs' ? anchors.find(id => legacyPath(`#${id}`, all)) : undefined
    if (moved) throw new Error(`/docs has a section #${moved}, an old address the app moves to ${legacyPath(`#${moved}`, all)}.`)
    return { html: marked, anchors }
  }
}

/** Where a window draws a page differently, each form is in it, marked (data-shell-media) and shown by MEDIA_CSS where the
 *  app would draw it: the same queries as lib/media.ts. (Over the forms' own display: a picker's class sets it too.) */
export const MEDIA_CSS = `@media ${PHONE}{[data-shell-media=wide]{display:none!important}}@media not all and ${PHONE}{[data-shell-media^=phone]{display:none!important}}@media ${TOUCH}{[data-shell-media=phone-fine]{display:none!important}}@media not all and ${TOUCH}{[data-shell-media=phone-touch]{display:none!important}}`
function withMedia(forms: [string, string][]): string {
  const base = forms[0]![1]
  if (forms.every(([, html]) => html === base)) return base
  if (forms[1]![1] === forms[2]![1]) forms = [forms[0]!, ['phone', forms[1]![1]]]
  // The part they share before and after, cut where an element starts: what lies between is whole elements in each.
  let start = 0
  while (forms.every(([, html]) => html[start] === base[start]) && start < base.length) start++
  start = base.lastIndexOf('<', start)
  let end = 0
  while (forms.every(([, html]) => html[html.length - 1 - end] === base[base.length - 1 - end]) && end < base.length - start) end++
  const tail = base.length - end
  end = base.length - (base.indexOf('<', tail) === -1 ? base.length : base.indexOf('<', tail))
  const middles = forms.map(([name, html]) => marked(html.slice(start, html.length - end), name))
  return base.slice(0, start) + middles.join('') + base.slice(base.length - end)
}
/** Each element at the top of an HTML fragment marked with its form; throws on a fragment that isn't whole elements. */
function marked(fragment: string, form: string): string {
  let depth = 0, out = ''
  for (const part of fragment.split(/(<[^>]+>)/)) {
    if (!part.startsWith('<')) { if (depth === 0 && part.trim()) throw new Error(`A window's form of a page has text outside an element: ${part.slice(0, 60)}`); out += part; continue }
    const closing = part.startsWith('</'), selfClosing = part.endsWith('/>') || /^<(?:br|hr|img|input|meta|link|source|wbr|area|base|col|embed|track)\b/.test(part)
    if (!closing && depth === 0) out += part.replace(/^<([a-zA-Z][\w-]*)/, `<$1 data-shell-media="${form}"`)
    else out += part
    if (closing) depth--; else if (!selfClosing) depth++
    if (depth < 0) throw new Error('A window\u2019s form of a page closes an element it didn\u2019t open.')
  }
  if (depth !== 0) throw new Error('A window\u2019s form of a page leaves an element open.')
  return out
}
/** Each copy button (the app's CopyAction) names the element whose text it copies (data-shell-copy), for home/shell/boot.js:
 *  the code it follows, the example's open panel, or the agent prompt's box. A copy button it can't place stops the build. */
function copies(html: string, path: string): string {
  const edits: [number, string][] = []
  let n = 0
  for (const button of html.matchAll(/<button [^>]*class="[^"]*\bcopy-action\b[^"]*"[^>]*>/g)) {
    const label = /aria-label="([^"]*)"/.exec(button[0])?.[1] ?? '', at = button.index!
    let source: number
    if (label === 'Copy code example') source = html.indexOf('<code', html.indexOf('data-active="true"', at))
    else if (label === 'Copy agent prompt') source = html.indexOf('<code', html.indexOf('agent-prompt__box', at))
    else {
      const close = html.lastIndexOf('</code>', at)
      if (close === -1 || !/^(?:<\/(?:pre|span)>)*$/.test(html.slice(close + 7, at))) throw new Error(`${path}: “${label}” follows no code it copies.`)
      source = html.lastIndexOf('<code', close)
    }
    if (source < 0) throw new Error(`${path}: “${label}” has no code to copy.`)
    const id = `c${n++}`
    edits.push([source + '<code'.length, ` data-shell-copy-source="${id}"`], [at + '<button'.length, ` data-shell-copy="[data-shell-copy-source=${id}]"`])
  }
  return edits.sort((a, b) => b[0] - a[0]).reduce((out, [i, text]) => out.slice(0, i) + text + out.slice(i), html)
}
/** The text a page says, as a browser decodes it from the HTML. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
