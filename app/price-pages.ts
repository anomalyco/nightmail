import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runnerImport, type Plugin, type Rollup } from 'vite'
import { productName, publicOrigin as canonicalOrigin } from '../api/src/brand.ts'
import { pruneCss, usedNames } from './critical-css.ts'
import { ENTRIES } from './src/features/pricing/compare/index.ts'
import { PRICE_LINKS, PRICE_PAGES_LIVE } from './src/features/pricing/live.ts'
import { PRICE_PAGES } from './src/features/pricing/pages.ts'
import { PANEL_IDS } from './src/features/pricing/panels.ts'
import { entryProblems, lastChecked } from './src/features/pricing/prices.ts'
import { jsonLd, llmsFull, llmsSiteIndex, markdownFiles, markdownPath, structuredData } from './src/features/pricing/readable.ts'

// The public price pages and what's made with them (features/pricing):
// - pricing.html and compare/<slug>.html, one for every comparison's entry (compare/index.ts): index.html with the
//   page's own title, description, canonical address, link preview (its card included: pages.ts), Markdown twin and
//   structured data, and the page itself painted from the HTML alone (prerender.tsx: the scene as the app first draws
//   it, in #price-shell) with the CSS it needs inlined (critical-css.ts), so it shows before any of the app's code.
//   The app's stylesheet and modules are out of the page: the homepage's boot script (home/shell/boot.js) starts them
//   at the reader's first touch, key or scroll (a press held, and what they typed, carried over) or after 8 s, and the
//   app's page then takes the painted one's place (index.tsx), with the inlined CSS. The Worker answers /pricing
//   with pricing.html from the assets, compressed (api/src/worker.ts), and api/src/server.ts does the same on Node; an
//   address under /compare/ with no page is not found.
// - Each page's Markdown twin, and the homepage's (readable.ts): pricing.md, compare/<slug>.md, index.md;
//   llms-site.txt, the lines the API's llms.txt puts under its title (api/src/site-index.ts); llms-full.txt.
// - robots.txt (every crawler welcome, and where the sitemap is) and sitemap.xml: the homepage and the price pages.
// The canonical address, og:url, the twins' links and the sitemap name the hosted site (brand.ts) on every stage; the
// card is fetched from the stage's own host, as index.html's is. While PRICE_PAGES_LIVE is false each page asks search
// engines not to index it and the sitemap leaves it out. The build stops on an entry without its sources (prices.ts,
// entryProblems) and on a footer link to a page that doesn't exist.
const attr = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
const prerenderModule = fileURLToPath(new URL('./src/features/pricing/prerender.tsx', import.meta.url))
const bootScript = fileURLToPath(new URL('./src/features/home/shell/boot.js', import.meta.url))
/** Over the app's own page until it takes over (index.tsx), and not at all at an address it doesn't show (theme.js,
 *  data-plain). Unseen until all of it has arrived (#root follows it): drawn while its HTML streams in, its rows grow as
 *  the rest of their tiles arrive. Chrome doesn't draw at all until then (<link rel="expect">, below); this keeps it
 *  still in browsers that ignore that. The rest is the app's stylesheet, cut down (it has no visibility:visible to show
 *  through). */
const SHELL_CSS = '#price-shell{position:absolute;top:0;left:0;z-index:2147483000;width:100%}html[data-shell=off] #price-shell{display:none}body:not(:has(>#root)) #price-shell{visibility:hidden}'
/** The first fonts (public/fonts/*-basic.woff2, features/pricing/fonts/README.md): the app's, cut down to these
 *  characters, and preloaded. The painted page knows only these (its CSS leaves out the app's own faces of those
 *  families: WHOLE_FACES), so it fetches nothing else; once the app's stylesheet is in, they still serve these
 *  characters (defined after its faces) and the whole fonts only the others. */
const BASIC = 'U+0020-007E,U+00A0,U+00A9,U+00AB,U+00AE,U+00B7,U+00BB,U+00D7,U+2010-2027,U+2030,U+2039-203A,U+20AC,U+2122,U+2190-2193,U+2212,U+2713,U+FEFF,U+FFFD'
/** What public/theme.js may set on <html> before the first paint, which the page's CSS may select. */
const THEME_ATTRIBUTES = ['data-theme', 'data-shell', 'data-member', 'data-overview-panel', 'style']
const WHOLE_FACES = /@font-face\{font-family:(?:Inter|OpenTUI Mono|"Inter"|"OpenTUI Mono");[^}]*\}/g
const FIRST_FONTS = [{ family: 'Inter', file: 'inter-basic.woff2', weight: '100 900' }, { family: 'OpenTUI Mono', file: 'opentui-regular-basic.woff2', weight: '400' }, { family: 'OpenTUI Mono', file: 'opentui-bold-basic.woff2', weight: '700' }]

export function pricePages(): Plugin {
  let publicDir = '', root = ''
  return {
    name: 'nightmail:price-pages', apply: 'build', enforce: 'post',
    configResolved(config) { publicDir = config.publicDir; root = config.root },
    generateBundle: { order: 'post', async handler(_options, bundle) {
      const today = new Date().toISOString().slice(0, 10)
      const problems = ENTRIES.flatMap(entry => entryProblems(entry, today, PANEL_IDS))
      if (new Set(ENTRIES.map(entry => entry.slug)).size !== ENTRIES.length) problems.push('Two comparisons have the same slug.')
      for (const [path] of PRICE_LINKS) if (!PRICE_PAGES.some(page => page.path === path)) problems.push(`live.ts links ${path}, which is no price page.`)
      if (problems.length) return this.error(`The price pages can't be built (features/pricing/compare):\n  ${problems.join('\n  ')}`)

      const index = bundle['index.html']
      if (index?.type !== 'asset') return this.error('The price pages are made from index.html, and the bundle has none.')
      const source = String(index.source)
      const origin = /<meta property="og:image" content="([^"]+)\/og\.png"/.exec(source)?.[1]
      if (!origin) return this.error('The price pages need index.html\'s og:image, to name their own address beside it.')

      // The app's files, out of the page (the boot script starts them), and the CSS the price pages load.
      let template = source
      const take = (pattern: RegExp) => { const found = [...template.matchAll(pattern)].map(match => match[1]!); template = template.replace(pattern, ''); return found }
      const entry = take(/\s*<script type="module" crossorigin src="([^"]+)"><\/script>/g), preload = take(/\s*<link rel="modulepreload" crossorigin href="([^"]+)">/g), styles = take(/\s*<link rel="stylesheet" crossorigin href="([^"]+)">/g)
      if (entry.length !== 1 || styles.length !== 1 || !template.includes('<div id="root"></div>')) return this.error('index.html is not shaped as the price pages expect: one entry module and one stylesheet, and #root.')
      const css = [...new Set([styles[0]!.slice(1), ...pageCss(bundle, ['/features/pricing/index.tsx', '/features/pricing/board-page.tsx'])])].map(file => {
        const asset = bundle[file]
        if (asset?.type !== 'asset') this.error(`The price pages' stylesheet ${file} isn't in the bundle.`)
        return String((asset as { source: string | Uint8Array }).source)
      }).join('')
      const fileOf = (path: string) => {
        const file = Object.values(bundle).find(item => item.type === 'asset' && item.originalFileNames.some(name => name.endsWith(path)))
        if (!file) this.error(`The price pages need ${path} in the bundle (board.css links it).`)
        return `/${file!.fileName}`
      }
      // The pictures of the first screen: the board's concrete (the largest thing on it, at the window's density) and the
      // wall behind it, the phone's or the wide window's (board.css).
      const wall = { phone: fileOf('pricing/board/wall-828.avif'), wide: fileOf('pricing/board/wall-1920.avif') }
      const boot = `/${this.getFileName(this.emitFile({ type: 'asset', name: 'home-boot.js', source: readFileSync(bootScript) }))}`
      const fonts = FIRST_FONTS.map(font => ({ ...font, url: `/fonts/${font.file}` }))
      for (const font of fonts) if (!existsSync(resolve(publicDir, font.url.slice(1)))) return this.error(`public${font.url} is missing (features/pricing/fonts/README.md makes it).`)
      const faces = fonts.map(font => `@font-face{font-family:'${font.family}';src:url(${font.url}) format('woff2');font-style:normal;font-weight:${font.weight};font-display:swap;unicode-range:${BASIC}}`).join('')
      const moondust = { x1: fileOf('pricing/board/moondust-384.avif'), x2: fileOf('pricing/board/moondust-768.avif') }
      const { module: prerender } = await runnerImport<typeof import('./src/features/pricing/prerender.tsx')>(prerenderModule, { root, configFile: false, logLevel: 'error' })

      for (const page of PRICE_PAGES) {
        if (!existsSync(resolve(publicDir, page.card.file))) return this.error(`${page.path}'s card, public/${page.card.file}, is missing: what it shows has changed (features/pricing/pages.ts). Make it with node scripts/price-cards.mjs and delete the old one.`)
        const title = `${page.title} · ${productName.toLowerCase()}`, canonical = canonicalOrigin + page.path, image = `${origin}/${page.card.file}`
        let html = template
        const set = (pattern: RegExp, value: string) => {
          if (!pattern.test(html)) this.error(`index.html has no ${pattern.source} for ${page.file}.`)
          html = html.replace(pattern, (_match, start: string) => start + value)
        }
        set(/(<title>)[^<]*/, attr(title))
        set(/(<meta name="description" content=")[^"]*/, attr(page.description))
        set(/(<meta property="og:title" content=")[^"]*/, attr(title))
        set(/(<meta property="og:description" content=")[^"]*/, attr(page.description))
        set(/(<meta name="twitter:title" content=")[^"]*/, attr(title))
        set(/(<meta name="twitter:description" content=")[^"]*/, attr(page.description))
        for (const name of ['property="og:image"', 'name="twitter:image"']) set(new RegExp(`(<meta ${name} content=")[^"]*`), attr(image))
        for (const name of ['property="og:image:alt"', 'name="twitter:image:alt"']) set(new RegExp(`(<meta ${name} content=")[^"]*`), attr(page.card.alt))
        set(/(<meta property="og:image:type" content=")[^"]*/, 'image/jpeg')
        set(/(<!-- Link previews\.)[^>]*-->/, ' This page\'s own (app/price-pages.ts). -->')
        set(/(<meta property="og:type" content="website" \/>)/, `\n    <meta property="og:url" content="${attr(canonical)}" />\n    <link rel="canonical" href="${attr(canonical)}" />`)
        set(/(<link rel="alternate" type="text\/markdown" href=")[^"]*(?=" title=")/, attr(canonicalOrigin + markdownPath(page.path)))
        set(/(<link rel="alternate" type="text\/markdown" href="[^"]*" title=")[^"]*/, attr(`${page.title}, in Markdown`))
        if (!PRICE_PAGES_LIVE) set(/(<meta charset="UTF-8" \/>)/, '\n    <meta name="robots" content="noindex" />')
        // The page, painted, with what it needs to show: its CSS, its first picture, and its structured data.
        const shell = prerender.renderShell(page)
        set(/(<link rel="manifest" href="\/site.webmanifest" \/>)/, `\n    <script type="application/ld+json">${jsonLd(structuredData(page))}</script>`)
        html = html.replace(/\s*<link rel="preload" href="\/fonts\/[^"]+" as="font" type="font\/woff2" crossorigin \/>/g, '')
        set(/(<script src="\/theme.js"><\/script>)/, [
          ...fonts.map(font => `<link rel="preload" href="${font.url}" as="font" type="font/woff2" crossorigin />`),
          `<link rel="preload" as="image" imagesrcset="${moondust.x1} 1x, ${moondust.x2} 2x" type="image/avif" fetchpriority="high" />`,
          `<link rel="preload" href="${wall.phone}" as="image" type="image/avif" media="(max-width: 640px)" />`,
          `<link rel="preload" href="${wall.wide}" as="image" type="image/avif" media="(min-width: 641px)" />`,
        ].map(line => `\n    ${line}`).join(''))
        set(/(<script src="\/theme.js")(?=><\/script>)/, ' data-plain=""')
        // Nothing is drawn until the whole painted page has arrived (#root follows it): over a slow connection a page drawn
        // while its HTML streams in grows as each row's rest arrives (Chrome; other browsers ignore it).
        set(/(<\/title>)/, '\n    <link rel="expect" href="#root" blocking="render" />')
        set(/(<\/title>)/, `\n    <style data-shell-css>${SHELL_CSS}${pruneCss(css, usedNames(html + shell, THEME_ATTRIBUTES)).replace(WHOLE_FACES, '')}</style>\n    <style>${faces}</style>`)
        html = html.replace('<div id="root"></div>', `<div id="price-shell">${shell}</div>\n    <div id="root"></div>\n    <script src="${boot}" defer data-shell="price-shell" data-press="button" data-wait="none" data-keep=".boot-loader, .price-page" data-css="${styles[0]}" data-preload="${preload.join(' ')}" data-entry="${entry[0]}"></script>`)
        this.emitFile({ type: 'asset', fileName: page.file, source: html })
      }
      for (const { file, source } of markdownFiles()) this.emitFile({ type: 'asset', fileName: file, source })
      this.emitFile({ type: 'asset', fileName: 'llms-site.txt', source: llmsSiteIndex() })
      this.emitFile({ type: 'asset', fileName: 'llms-full.txt', source: llmsFull() })
      const listed = [{ path: '/', modified: null as string | null }, ...PRICE_PAGES_LIVE ? PRICE_PAGES.map(page => ({ path: page.path, modified: page.comparison ? lastChecked(page.comparison) : null })) : []]
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: `User-agent: *\nAllow: /\n\nSitemap: ${canonicalOrigin}/sitemap.xml\n` })
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${listed.map(({ path, modified }) => `  <url><loc>${canonicalOrigin}${path}</loc>${modified ? `<lastmod>${modified}</lastmod>` : ''}</url>\n`).join('')}</urlset>\n` })
    } },
  }
}

/** The files a price page's first screen and its app need, for the cache rules (asset-headers.ts): next in line after
 *  the homepage's. */
export const priceFirstFiles = (files: string[]) => [/^assets\/(?:moondust-\d+|wall-\d+|lamp)-[\w-]+\.(?:avif|webp)$/, /^assets\/(?:pricing|board-page|machines)-[\w-]+\.(?:js|css)$/]
  .flatMap(pattern => files.filter(name => pattern.test(name)))

/** The stylesheets the chunks of these modules load, theirs and their imports'. */
function pageCss(bundle: Rollup.OutputBundle, modules: string[]) {
  const css = new Set<string>(), seen = new Set<string>()
  const visit = (chunk: Rollup.OutputChunk) => {
    if (seen.has(chunk.fileName)) return
    seen.add(chunk.fileName)
    for (const file of chunk.viteMetadata?.importedCss ?? []) css.add(file)
    for (const name of chunk.imports) { const next = bundle[name]; if (next?.type === 'chunk') visit(next) }
  }
  for (const module of modules) {
    const chunk = Object.values(bundle).find((item): item is Rollup.OutputChunk => item.type === 'chunk' && !!item.facadeModuleId?.endsWith(module))
    if (chunk) visit(chunk)
  }
  return [...css]
}
