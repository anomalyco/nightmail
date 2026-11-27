import { pruneCss, usedNames } from './critical-css.ts'
import { dashboardNoticeHtml, dashboardNoticeStyles, dashboardReference } from '../api/src/dashboard-reference.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runnerImport, type Plugin } from 'vite'
import { productName, publicOrigin } from '../api/src/brand.ts'
import { describeBody, NO_FIELD_BODIES, responseRows } from '../api/src/schema-fields.ts'
import { isPublicPage, RENAMED_OPERATIONS } from '../api/src/site-index.ts'
import { legalMarkdown, renderLegal } from './legal-markdown.ts'
import { linkCard, maxLine, shareTitle, withCard, type CardWords } from './link-card.ts'
import { appFiles, pageCss, paint, paintedCss } from './painted-page.ts'
import { GUIDE_NAMES } from './src/features/docs/guide-names.ts'
import { docsTitle, operationDescription, operationEntries, operationTitle } from './src/features/docs/meta.ts'

// The site's own pages beside the price pages (price-pages.ts), each index.html with its own title, description,
// canonical address, Markdown twin and link-preview card in its head, so a search engine, an agent or a link preview
// reading the first response knows which page it is. A docs page's body is the dashboard's, byte for byte, and the page
// renders in it as before, signed in or out.
// - The docs (features/docs): docs.html for /docs, docs/<guide>.html for each guide (guide-names.ts) and
//   docs/api/<id>.html for every operation in api/openapi.json (the definition the docs render), with the titles and
//   descriptions the page sets as it renders (features/docs/meta.ts). Cards: one for /docs, one for each guide; the
//   operations share the docs' card.
// - The legal pages (features/legal): legal.html for /legal and legal/<slug>.html for each document in
//   features/legal/content, named and described by its front matter, its card dated by its `updated`. Each document's
//   Markdown is its twin (legal/<slug>.md), and the index's is legal.md. Their body isn't the dashboard's: the page
//   itself is painted in it for a visitor (features/legal/prerender.tsx, painted-page.ts), so a reader, a search engine
//   or an agent gets the document's words in the first response. It is drawn by the app's own page from the same
//   compiled Markdown the app shows (legal-markdown.ts), and the build stops if a document's HTML isn't in it byte for
//   byte. The app takes its place at the first touch, key or scroll (useShellTakeover). A browser that has signed in
//   gets the app from the start, as before (public/theme.js, data-members).
// Each is listed in sitemap.xml (below). Workers Assets and api/src/server.ts serve each file at its address; an
// operation or a legal document with no page is not found (api/src/site-index.ts). The canonical address names the hosted site on every stage, as the price pages' does;
// the card is fetched from the stage's own host, as index.html's is; a stage on another host still asks not to be
// indexed (vite.config.ts, publicOrigin).
const attr = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
const openApi = fileURLToPath(new URL('../api/openapi.json', import.meta.url))
const legalContent = fileURLToPath(new URL('./src/features/legal/content/', import.meta.url))
const legalShell = fileURLToPath(new URL('./src/features/legal/prerender.tsx', import.meta.url))
const docsShell = fileURLToPath(new URL('./src/features/docs/prerender.tsx', import.meta.url))
const bootScript = fileURLToPath(new URL('./src/features/home/shell/boot.js', import.meta.url))
/** A painted legal page shows the theme switch theme.js's theme has (features/legal/prerender.tsx draws one for each); with
 *  no script, the light one. */
const THEME_SWITCH = 'html:not([data-theme=dark]) #page-shell [data-theme-only=dark],html[data-theme=dark] #page-shell [data-theme-only=light]{display:none}'

/** names: a docs page's own names, without the docs', longest first (a link preview's title falls back to them).
 *  modified: the sitemap's lastmod (YYYY-MM-DD), where the page has a date of its own. */
type SitePage = { path: string; title: string; names?: string[]; description: string; markdown: string; card: CardWords; twin?: string; modified?: string; painted?: { html?: string }; operation?: string }

/** Where a page is drawn at build time, its stylesheets are the bundle's (painted-page.ts inlines them), not modules: Vite's
 *  module runner has no CSS pipeline. */
const noCss: Plugin = {
  name: 'nightmail:no-css', enforce: 'pre',
  resolveId: source => /\.css(?:\?|$)/.test(source) ? '\0no-css' : null,
  load: id => id === '\0no-css' ? 'export default ""' : null,
}

/** Text as React writes it in HTML (renderToStaticMarkup escapes these five). */
const reactText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
/** An operation's parameter names, where its definition lists them inline (a $ref'd one is checked by the page itself). */
const operationParameters = (operation: { operation: Record<string, any>; pathItem: Record<string, any> }) =>
  [...(Array.isArray(operation.pathItem.parameters) ? operation.pathItem.parameters : []), ...(Array.isArray(operation.operation.parameters) ? operation.operation.parameters : [])].flatMap(parameter => typeof parameter?.name === 'string' ? [parameter.name as string] : [])

/** An operation's bodies as its page lists them (api/src/schema-fields.ts, which its Markdown copy lists the same way):
 *  every field and variant the page must name, and any body it would show by name only, with no fields, which stops the
 *  build (but for the request bodies that have none, NO_FIELD_BODIES). */
function bodies(document: Record<string, any>, operation: { id: string; operation: Record<string, any> }) {
  const schemas: [string, Record<string, any> | undefined][] = [['request body', operation.operation.requestBody?.content?.['application/json']?.schema], ...responseRows(operation.operation.responses ?? {}).map(row => [`${row.statuses.join(', ')} response`, row.schema] as [string, Record<string, any> | undefined])]
  const names: string[] = [], nameOnly: string[] = []
  for (const [where, schema] of schemas) {
    if (!schema) continue
    const body = describeBody(document, schema)
    if (body.kind === 'fields') names.push(...body.fields.map(field => field.path))
    else if (body.kind === 'variants') names.push(...body.variants.flatMap(variant => [variant.title, ...variant.fields.map(field => field.path)]))
    else if (!(body.kind === 'empty' && where === 'request body' && NO_FIELD_BODIES.has(operation.id))) nameOnly.push(`its ${where} (${body.kind === 'value' ? body.type : 'an object with no fields'})`)
  }
  return { names, nameOnly }
}

/** A legal document's date as its front matter writes it ("26 November 2026"), as a sitemap's lastmod (2026-11-26). */
function isoDay(day: string): string {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const match = /^(\d{1,2}) ([A-Z][a-z]+) (\d{4})$/.exec(day.trim()), month = match ? months.indexOf(match[2]!) : -1
  if (!match || month < 0) throw new Error(`A legal document's date isn't "26 November 2026"-shaped: ${day}`)
  return `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1]!.padStart(2, '0')}`
}

/** A title as a card's lines: one if it fits, else two (a card has room for no more) of near lengths, the first the longer
 *  by a little ("Give a coding agent / its own key", "Send from the / built-in domain"). */
function titleLines(title: string): CardWords['lines'] {
  if (title.length <= maxLine()) return [title]
  const words = title.split(' '), score = ([a, b]: [string, string]) => Math.max(a.length, b.length + 3)
  const splits = words.slice(1).map((_, i) => [words.slice(0, i + 1).join(' '), words.slice(i + 1).join(' ')] as [string, string])
  return splits.reduce((best, split) => score(split) < score(best) ? split : best)
}

/** origin: the address the build is made for, where it names one (VITE_PUBLIC_URL: the deploy's stages, the layout check's
 *  fixture). Only then are the reference pages painted, with examples for that address; a build that doesn't know its
 *  address (a self-hosted image) writes their heads alone, as before, so no example ever names another installation. */
export function sitePages({ address }: { address: string | null }): Plugin {
  let root = ''
  return {
    name: 'nightmail:site-pages', apply: 'build', enforce: 'post',
    configResolved(config) { root = config.root },
    generateBundle: { order: 'post', async handler(_options, bundle) {
      const index = bundle['index.html']
      if (index?.type !== 'asset') return this.error('The site\'s pages are made from index.html, and the bundle has none.')
      const source = String(index.source)
      const origin = /<meta property="og:image" content="([^"]+)\/og\.png"/.exec(source)?.[1]
      if (!origin) return this.error('The site\'s pages need index.html\'s og:image, to name their cards\' address beside it.')

      const document = JSON.parse(readFileSync(openApi, 'utf8')) as { info: { description?: string }; paths: Record<string, Record<string, unknown>> }
      const operations = operationEntries(document)
      const docsCard: CardWords = { name: 'docs', lines: ['API documentation.', `${operations.length} operations.`], caption: `The ${productName} API reference and ${GUIDE_NAMES.length} guides.` }
      const legal = readdirSync(legalContent).filter(file => file.endsWith('.md')).sort().map(file => {
        const text = readFileSync(legalContent + file, 'utf8').replace(/\r\n/g, '\n'), doc = renderLegal(text, file)
        return { slug: file.slice(0, -3), ...doc, body: text.replace(/^---\n[\s\S]*?\n---\n/, '').trim() }
      })
      const legalTitle = (title: string) => `${title} · ${productName.toLowerCase()}`
      const latest = legal.map(doc => doc.updated).sort((a, b) => Date.parse(b) - Date.parse(a))[0]!
      const pages: SitePage[] = [
        { path: '/docs', title: docsTitle(null), description: document.info.description ?? '', markdown: '/docs.md', card: docsCard },
        ...GUIDE_NAMES.map(guide => ({ path: `/docs/${guide.id}`, title: docsTitle(guide.title), names: [guide.title], description: guide.summary, markdown: '/docs.md', card: { name: `docs-${guide.id}`, lines: titleLines(guide.title), caption: `Guide · ${productName} API docs` } })),
        ...operations.map(operation => ({ path: `/docs/api/${operation.id}`, title: docsTitle(operation.summary), names: [operation.summary, operationTitle(operation.id)], description: operationDescription(operation), markdown: `/docs/operations/${operation.id}.md`, card: docsCard, operation: operation.id })),
        { path: '/legal', title: legalTitle('Legal'), modified: isoDay(latest), description: `The terms and policies that apply to ${productName}: ${legal.map(doc => doc.title).join(', ')}.`, markdown: '/legal.md',
          card: { name: 'legal', lines: ['Terms and policies'], caption: `${legal.length} documents, last updated ${latest}.` }, painted: {},
          twin: [`# Legal`, `Canonical page: ${publicOrigin}/legal`, `The terms and policies that apply to ${productName}.`, legal.map(doc => `- [${doc.title}](${publicOrigin}/legal/${doc.slug}.md): ${doc.description} Updated ${doc.updated}.`).join('\n')].join('\n\n') + '\n' },
        ...legal.map(doc => ({ path: `/legal/${doc.slug}`, title: legalTitle(doc.title), modified: isoDay(doc.updated), description: doc.description, markdown: `/legal/${doc.slug}.md`,
          card: { name: `legal-${doc.slug}`, lines: titleLines(doc.title), caption: `Updated ${doc.updated}.` }, painted: { html: doc.html },
          twin: [`# ${doc.title}`, `Canonical page: ${publicOrigin}/legal/${doc.slug}`, `Updated ${doc.updated}. Effective ${doc.effective}.`, doc.body].join('\n\n') + '\n' })),
      ]
      // Each is a public page, where a visitor isn't asked for a session (api/src/site-index.ts, PUBLIC_PAGE).
      const unlisted = pages.filter(page => !isPublicPage(page.path)).map(page => page.path)
      if (unlisted.length) return this.error(`api/src/site-index.ts's PUBLIC_PAGE leaves out ${unlisted.join(', ')}: a visitor would be asked for a session there.`)
      // The painted pages: the app's files out of them (the boot script starts them), the CSS the legal page loads in the
      // app, and the page drawn by the app's own components (prerender.tsx, with the same Markdown plugin as the app's build).
      const files = appFiles(source)
      if (!files) return this.error('index.html is not shaped as a painted page expects: one entry module and one stylesheet, and #root.')
      // The boot script the price pages load (the television homepage has its own of the same name).
      const bootSource = readFileSync(bootScript, 'utf8'), text = (source: string | Uint8Array) => typeof source === 'string' ? source : new TextDecoder().decode(source)
      const boot = Object.values(bundle).find(file => file.type === 'asset' && text(file.source) === bootSource)?.fileName
        ?? this.getFileName(this.emitFile({ type: 'asset', name: 'home-boot.js', source: bootSource }))
      const legalCss = [...new Set([files.css.slice(1), ...pageCss(bundle, ['/features/legal/index.tsx'])])].map(file => {
        const asset = bundle[file]
        if (asset?.type !== 'asset') this.error(`The legal pages' stylesheet ${file} isn't in the bundle.`)
        return String((asset as { source: string | Uint8Array }).source)
      }).join('')
      const { module: shell } = await runnerImport<typeof import('./src/features/legal/prerender.tsx')>(legalShell, { root, configFile: false, logLevel: 'error', plugins: [legalMarkdown(), noCss] })
      // The docs pages (the overview, the 10 guides, the published operations' reference), where the build knows its address: drawn
      // by the app's docs page as a signed-out visitor sees it (prerender.tsx) from the API definition it fetches, with one
      // stylesheet for all of them (the docs' CSS cut down to what any of them uses).
      const docsModule = address ? (await runnerImport<typeof import('./src/features/docs/prerender.tsx')>(docsShell, { root, configFile: false, logLevel: 'error', plugins: [noCss] })).module : null
      const painter = docsModule?.docsPainter(document as never, address!) ?? null
      const reference = new Map(painter ? pages.flatMap(page => page.path === '/docs' || page.path.startsWith('/docs/') ? [[page.path, painter(page.path)] as const] : []) : [])
      const docsPaint = { shell: 'page-shell', extraCss: docsModule?.MEDIA_CSS, css: [...new Set([files.css.slice(1), ...pageCss(bundle, ['/features/docs/index.tsx'])])].map(file => {
        const asset = bundle[file]
        if (asset?.type !== 'asset') this.error(`The docs' stylesheet ${file} isn't in the bundle.`)
        return String((asset as { source: string | Uint8Array }).source)
      }).join('') }
      // The servers' 410 notice uses the same reference styles, including on builds without painted pages.
      this.emitFile({ type: 'asset', fileName: dashboardNoticeStyles, source: pruneCss(docsPaint.css, usedNames(dashboardNoticeHtml)) })
      const sheet = reference.size ? `/${this.getFileName(this.emitFile({ type: 'asset', name: 'docs-painted.css', source: paintedCss(docsPaint, files.template + [...reference.values()].map(drawn => drawn.html).join('')) }))}` : undefined
      for (const page of pages) {
        const card = linkCard(page.card)
        if (!bundle[card.file]) this.emitFile({ type: 'asset', fileName: card.file, source: card.source })
        let html = withCard(page.painted || reference.has(page.path) ? files.template : source, card, origin)
        const set = (pattern: RegExp, value: string) => {
          if (!pattern.test(html)) this.error(`index.html has no ${pattern.source} for ${page.path}.`)
          html = html.replace(pattern, (_match, start: string) => start + value)
        }
        const canonical = publicOrigin + page.path
        set(/(<title>)[^<]*/, attr(page.title))
        for (const name of ['name="description"', 'property="og:description"', 'name="twitter:description"']) set(new RegExp(`(<meta ${name} content=")[^"]*`), attr(page.description))
        // A link preview's title: the page's title if it fits a small card, else one of its names, with the docs' name as the
        // title has it or alone (an operation's summary, else its name: link-card.ts).
        const share = shareTitle(page.title, ...(page.names ?? []).flatMap(name => [docsTitle(name), name]))
        for (const name of ['property="og:title"', 'name="twitter:title"']) set(new RegExp(`(<meta ${name} content=")[^"]*`), attr(share))
        set(/(<!-- Link previews\.)[^>]*-->/, ' This page\'s own (app/site-pages.ts). -->')
        set(/(<meta property="og:type" content="website" \/>)/, `\n    <meta property="og:url" content="${attr(canonical)}" />\n    <link rel="canonical" href="${attr(canonical)}" />`)
        set(/(<link rel="alternate" type="text\/markdown" href=")[^"]*(?=" title=")/, attr(publicOrigin + page.markdown))
        set(/(<link rel="alternate" type="text\/markdown" href="[^"]*" title=")[^"]*/, attr(`${page.title}, in Markdown`))
        if (page.painted) {
          const body = shell.renderLegalShell(page.path)
          // The document the app shows, as the page says it: its compiled Markdown, byte for byte.
          if (page.painted.html !== undefined && !body.includes(page.painted.html)) return this.error(`${page.path} is painted without its document's HTML as legal-markdown.ts compiles it: the app's page and this one would differ.`)
          html = paint(html, { shell: 'page-shell', body, css: legalCss, extraCss: THEME_SWITCH, keep: '.boot-loader, .legal-page', boot: `/${boot}`, files, members: true, wholeFaces: true })
        }
        const drawn = reference.get(page.path)
        if (drawn) {
          // What the page's Markdown copy says of it, as the page says it: an operation's name, call, description and
          // parameters; a guide's title and summary; the overview's description of the API.
          const operation = operations.find(item => item.id === page.operation), guide = GUIDE_NAMES.find(item => page.path === `/docs/${item.id}`)
          const said = (operation ? [operation.summary, operation.path, operation.description, ...operationParameters(operation)] : guide ? [guide.title, guide.summary] : [document.info.description ?? '']).filter(Boolean).map(text => reactText(text))
          const missing = said.find(text => !drawn.html.includes(text))
          if (missing !== undefined) return this.error(`${page.path} is painted without “${missing}”, which its own copy says.`)
          if (operation) {
            const { names, nameOnly } = bodies(document, operation)
            if (nameOnly.length) return this.error(`${page.path} shows ${nameOnly.join(' and ')} by name only, with none of its fields: list them (api/src/schema-fields.ts), or add the operation to NO_FIELD_BODIES if the body truly has none.`)
            const unnamed = names.find(name => !drawn.html.includes(`<code>${reactText(name)}</code>`))
            if (unnamed !== undefined) return this.error(`${page.path} is painted without its body's “${unnamed}”, which its Markdown copy lists.`)
          }
          // The overview answers only its own sections' addresses (#agent-prompt, #sending-limits): any other hash is a page the
          // app moves elsewhere (/docs#guide-rituals, /docs#sendEmail: index.tsx legacyPath), so theme.js lets the app draw it.
          html = paint(html, { ...docsPaint, body: drawn.html, keep: '.boot-loader, .docs-page', boot: `/${boot}`, files, sheet, members: true, origin: address!, anchors: page.path === '/docs' ? drawn.anchors : undefined })
        }
        this.emitFile({ type: 'asset', fileName: `${page.path.slice(1)}.html`, source: html })
        if (page.twin) this.emitFile({ type: 'asset', fileName: page.markdown.slice(1), source: page.twin })
      }
      // Every page here joins the sitemap the price pages wrote (price-pages.ts, earlier in vite.config.ts's plugins): each
      // is public, answers 200 and names itself as canonical (the support agent's operations are in no API definition, so
      // they have no page here and stay not found). A legal document's lastmod is its own updated date, the index's the
      // newest of them. The docs pages have none: api/openapi.json carries no date, and the deploy's checkout is shallow
      // (a Docker build has no history), so a date from git would claim every page changed on every deploy, and no
      // lastmod is truer than that. One file for all of them: 345 addresses are far inside a sitemap's 50,000, and the
      // address Search Console reads (robots.txt names it) stays the same.
      const sitemap = bundle['sitemap.xml']
      if (sitemap?.type !== 'asset' || !String(sitemap.source).includes('</urlset>')) return this.error('The site\'s pages join sitemap.xml, which price-pages.ts writes first: the bundle has none.')
      sitemap.source = String(sitemap.source).replace('</urlset>', pages.map(page => `  <url><loc>${publicOrigin}${page.path}</loc>${page.modified ? `<lastmod>${page.modified}</lastmod>` : ''}</url>\n`).join('') + '</urlset>')
      // Cloudflare serves existing assets before the Worker. Neither old spelling may mask its 301/410.
      for (const id of dashboardReference.keys()) {
        if (bundle[`docs/api/${id}.html`] || bundle[`docs/operations/${id}.md`]) this.error(`Unexpected dashboard reference asset: ${id}`)
      }
      // An old name redirects to its new page (site-index.ts): the page must exist, and the old name must be no operation's.
      for (const [old, now] of Object.entries(RENAMED_OPERATIONS)) if (!pages.some(page => page.path === `/docs/api/${now}`) || pages.some(page => page.path === `/docs/api/${old}`)) this.error(`RENAMED_OPERATIONS (api/src/site-index.ts) sends ${old} to ${now}, which has no reference page, or ${old} is an operation again.`)
      if (!pages.some(page => page.path === '/docs/api/sendEmail')) this.error(`The docs pages have no sendEmail: api/openapi.json isn't ${productName}'s API definition.`)
      if (!pages.some(page => page.path === '/legal/terms')) this.error('The legal pages have no terms: features/legal/content has no terms.md.')
    } },
  }
}
