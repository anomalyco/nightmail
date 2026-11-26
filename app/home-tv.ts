import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runnerImport, type Plugin, type Rollup } from 'vite'
import { productName, publicOrigin } from '../api/src/brand.ts'
import { pruneCss, usedNames } from './critical-css.ts'
import type { HomeStart } from './src/features/home/index.tsx'
import { jsonLd, structuredData } from './src/features/home/tv/readable.ts'

// The television homepage (features/home/tv) in place of the factory's (home-shell.ts), in a build made with
// VITE_HOME=tv (vite.config.ts; the deploy sets it for the dev stage, .github/workflows/deploy.yml). It changes:
// - the app's homepage and its first picture (televisionHome's swap, below): the rest of the app imports them from
//   features/home/index.tsx and first-picture.ts, the factory's, and with the television those imports resolve to
//   tv/home.tsx and tv/first-picture.ts instead, so the factory's homepage is not in this build, and nothing of the
//   television is in a build without it;
// - home.html's first screen (homeShell, below) and its files' cache rules (televisionFirstFiles);
// - index.html's description and its link preview's picture and words (words and picture, below);
// - what the Markdown twins and the structured data say of the homepage and the product (tv/readable.ts, which
//   vite.config.ts gives price-pages.ts too).

// home.html: the homepage's first screen, painted from the HTML alone. A hosted installation's Worker answers "/" with
// it (api/src/worker.ts); every other path, and "/" on a self-hosted one, gets index.html as before. It is index.html
// with the television in it as the app first renders it (tv/tv.tsx, rendered here with React, so its markup, its words
// and the places of its parts are the page's own), and the app's stylesheet cut down to that markup (critical-css.ts),
// so it is laid out by the same rules. What only the app can do is left out (the picture's shader, the remote, the
// knobs, sound): behind the glass is a still of the tape's opening page instead (tv/crt/still.webp), with the room
// lit as the page lights it for that picture (tv/crt/still.json: the light, its colour, the table's two reflections).
// The app's stylesheet and modules are not in the page: home-boot.js starts them once the set's pictures are in
// (features/home/tv/shell/boot.js), and gives the page's own place to it once it has drawn its picture.
//
// The still is the live page's own frame, captured from it in headless Chromium with reduced motion (the tape's one
// still frame) at 1280 x 658 and 2x, so the canvas is 964 x 720 (three device pixels a scanline): the canvas's pixels
// (read back with preserveDrawingBuffer) as still.webp (cwebp -q 60 -m 6 -sharp_yuv), the reflections' two canvases
// and the set's --light and --tint as still.json. Capture it again when what the tape's first page shows changes.

const at = (path: string) => fileURLToPath(new URL(`./src/features/home/${path}`, import.meta.url))
const TV = at('tv/tv.tsx')
const css = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{};])\s*/g, '$1').replace(/,\s+/g, ',').trim()
type Still = { light: number; tint: string; reflect: { shade: string; tint: string } }
/** The first fonts: the app's own, cut down to Basic Latin (public/fonts/*-basic.woff2, the same list as price-pages.ts's
 *  BASIC: features/pricing/fonts/README.md). The terms are set in Inter, the label in OpenTUI Mono's bold. Defined after
 *  the app's faces, they go on serving these characters once its stylesheet is in, so the page's own words don't change
 *  font as it takes over. */
const BASIC = 'U+0020-007E,U+00A0,U+00A9,U+00AB,U+00AE,U+00B7,U+00BB,U+00D7,U+2010-2027,U+2030,U+2039-203A,U+20AC,U+2122,U+2190-2193,U+2212,U+2713,U+FEFF,U+FFFD'
const FIRST_FONTS = [{ family: 'Inter', file: 'inter-basic.woff2', weight: '100 900' }, { family: 'OpenTUI Mono', file: 'opentui-bold-basic.woff2', weight: '700' }]
const WHOLE_FACES = /@font-face\{font-family:(?:Inter|OpenTUI Mono|"Inter"|"OpenTUI Mono");[^}]*\}/g
/** What public/theme.js may set on <html> before the first paint, which the page's CSS may select. */
const THEME_ATTRIBUTES = ['data-theme', 'data-shell', 'data-member', 'data-overview-panel', 'style']
/** Left out of the page's render: its stylesheets, and the dashboard's data layer (data/prefetch.ts, for Open dashboard's
 *  link, which a visitor's page doesn't render), which opens a channel as it loads that would keep the build running. */
const STUBS: [RegExp, string][] = [[/\.css$/, 'export default ""'], [/\/data\/prefetch(?:\.ts)?$/, 'export const useRouteIntent = () => () => ({})']]
const renderOnly: Plugin = {
  name: 'nightmail:home-shell-render', enforce: 'pre',
  resolveId: id => { const i = STUBS.findIndex(([pattern]) => pattern.test(id)); return i < 0 ? null : `\0home-shell-stub-${i}` },
  load: id => id.startsWith('\0home-shell-stub-') ? STUBS[Number(id.slice('\0home-shell-stub-'.length))]![1] : null,
}

function homeShell(): Plugin {
  let root = '', publicDir = ''
  return {
    name: 'nightmail:home-shell', apply: 'build', enforce: 'post',
    configResolved(config) { root = config.root; publicDir = config.publicDir },
    generateBundle: { order: 'post', async handler(_options, bundle) {
      const index = bundle['index.html']
      if (index?.type !== 'asset') return this.error('home.html is made from index.html, and the bundle has none.')
      const url = (path: string) => {
        const file = Object.values(bundle).find(item => item.type === 'asset' && item.originalFileNames.some(name => name.endsWith(`features/home/${path}`)))
        if (!file) this.error(`home.html needs ${path} in the bundle (tv.tsx imports it).`)
        return `/${file!.fileName}`
      }
      const emit = (name: string, path: string) => `/${this.getFileName(this.emitFile({ type: 'asset', name, source: readFileSync(at(path)) }))}`
      const boot = emit('home-boot.js', 'tv/shell/boot.js'), picture = emit('still.webp', 'tv/crt/still.webp'), scene = url('tv/crt/scene.webp')
      const still = JSON.parse(readFileSync(at('tv/crt/still.json'), 'utf8')) as Still
      const fonts = FIRST_FONTS.map(font => ({ ...font, url: `/fonts/${font.file}` }))
      for (const font of fonts) if (!existsSync(resolve(publicDir, font.url.slice(1)))) return this.error(`public${font.url} is missing (features/pricing/fonts/README.md makes it).`)

      // The app's files, out of the page: home-boot.js starts them.
      let html = String(index.source)
      const take = (pattern: RegExp) => { const found = [...html.matchAll(pattern)].map(match => match[1]!); html = html.replace(pattern, ''); return found }
      const entry = take(/\s*<script type="module" crossorigin src="([^"]+)"><\/script>/g), preload = take(/\s*<link rel="modulepreload" crossorigin href="([^"]+)">/g), styles = take(/\s*<link rel="stylesheet" crossorigin href="([^"]+)">/g)
      take(/\s*<link rel="preload" href="(\/fonts\/[^"]+)" as="font" type="font\/woff2" crossorigin \/>/g)
      if (entry.length !== 1 || styles.length !== 1 || !html.includes('<script src="/theme.js"></script>') || !html.includes('<div id="root"></div>')) return this.error('index.html is not shaped as home.html expects: one entry module and one stylesheet, theme.js, #root.')

      // The page as the app first renders it for a visitor. For someone signed in it differs only in the way in (Open
      // dashboard: home/start.tsx's DashboardLink, which needs the app's data to render, so it is written out here) and
      // the line under the table (tv.tsx: the visitor's, from its Pricing link on). Both are in the page, and theme.js's
      // data-member (a browser that has had a dashboard) picks the one shown.
      const { module: tv } = await runnerImport<typeof import('./src/features/home/tv/tv.tsx')>(TV, { root, configFile: false, logLevel: 'error', plugins: [renderOnly] })
      const [{ createElement }, { renderToStaticMarkup }, { MemoryRouter }] = await Promise.all([import('react'), import('react-dom/server'), import('react-router')])
      const visitor: HomeStart = { signedIn: false, onSignIn() {}, onSignInIntent() {}, busy: false }
      let shell = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/'] }, createElement(tv.TvHome, { start: visitor })))
        .replace(/^(?:<link rel="preload"[^>]*\/>)+/, '').replace(/\/src\/features\/home\/([\w./-]+\.(?:webp|avif|png|jpg))/g, (_match, path: string) => url(path))
      const swap = (pattern: RegExp, to: string | ((...found: string[]) => string), count = 1) => {
        if ([...shell.matchAll(new RegExp(pattern.source, 'g'))].length !== count) this.error(`home.html expects ${count} of ${pattern.source} in the homepage (tv.tsx).`)
        shell = shell.replace(pattern, to as string)
      }
      const mark = (element: string, name: string) => element.replace(/^(<\w+\b[^>]*?\sclass=")([^"]*)"/, `$1$2 ${name}"`)
      const arrow = /<svg\b[^>]*\bsrt-cta-arrow\b[\s\S]*?<\/svg>/.exec(shell)?.[0] ?? ''
      swap(/(<div class="chyp(?: chyp-under)?">)(<button\b[^>]*\sclass="chyp-go"[\s\S]*?<\/button>)(<\/div>)/g, (_match, open, way, close) => `${open}${mark(way!, 'hs-visitor')}<a class="chyp-go hs-member" href="/overview"><span class="srt-cta-label">Open dashboard${arrow}</span></a>${close}`, 2)
      swap(/<p class="sign-in-consent chy-consent">[\s\S]*?<span aria-hidden="true"> · <\/span>(<a href="\/pricing">[\s\S]*?<\/p>)(?=<\/div><\/div><\/main>$)/, (line, more) => `${mark(line!, 'hs-visitor')}<p class="chy-consent hs-member">${more}`)
      // Behind the glass, the still, where the live picture's canvas goes; the table's reflections as the page draws
      // them for it; the room at the page's light; no remote and no knobs (they are drawn by the app).
      swap(/(<button[^>]*class="chy-screen"[^>]*>)<canvas aria-hidden="true"><\/canvas>/, `$1<img class="hs-still" src="${picture}" alt="" width="964" height="720" fetchpriority="high">`)
      swap(/<canvas class="chy-reflect chy-reflect-(shade|tint)" aria-hidden="true"><\/canvas>/g, '<img class="chy-reflect chy-reflect-$1" src="%$1%" alt="">', 2)
      shell = shell.replace(/%(shade|tint)%/g, (_match, which: 'shade' | 'tint') => still.reflect[which])
      swap(/<div class="chy-set">/, `<div class="chy-set" style="--tint:${still.tint};--light:${still.light}">`)
      swap(/<img class="chy-scene"/, '<img class="chy-scene" fetchpriority="high"')
      shell = shell.replace(/<canvas class="chy-remote"[^>]*><\/canvas>|<button[^>]*class="chy-remote-spot"[^>]*><\/button>|<button[^>]*class="chy-knob"[^>]*>[\s\S]*?<\/button>/g, '')

      // The app's stylesheet and the page's, less what nothing in the first screen uses, and their faces of the two
      // families, which the first fonts stand in for.
      const sheets = [...new Set([styles[0]!.slice(1), ...pageCss(bundle, TV)])].map(file => {
        const asset = bundle[file]
        if (asset?.type !== 'asset') this.error(`home.html's stylesheet ${file} isn't in the bundle.`)
        return String((asset as Rollup.OutputAsset).source)
      }).join('')
      const pruned = pruneCss(sheets, usedNames(html + shell, THEME_ATTRIBUTES)).replace(WHOLE_FACES, '')
      const floor = /:root:has\(\.chy\) body\{background:([^;}]+)/.exec(pruned)?.[1]
      if (!floor) return this.error('home.html takes the page\'s dark from tv.css (:root:has(.chy) body { background }), and it has none.')
      const own = css(readFileSync(at('tv/shell/shell.css'), 'utf8').replaceAll('%FLOOR%', floor))
      const faces = fonts.map(font => `@font-face{font-family:'${font.family}';src:url(${font.url}) format('woff2');font-style:normal;font-weight:${font.weight};font-display:swap;unicode-range:${BASIC}}`).join('')

      html = html
        .replace('<script src="/theme.js"></script>', [
          `<link rel="preload" href="${scene}" as="image" fetchpriority="high" />`,
          `<link rel="preload" href="${picture}" as="image" fetchpriority="high" />`,
          ...fonts.map(font => `<link rel="preload" href="${font.url}" as="font" type="font/woff2" crossorigin />`),
          '<script src="/theme.js" data-home></script>',
        ].join('\n    '))
        .replace(/<title>[^<]*<\/title>/, `<title>${productName.toLowerCase()} · Email for $0.20 per 1,000</title>`)
        // (Served only at the hosted site's "/", so it can name its address: the sitemap lists it, app/price-pages.ts.)
        .replace(/<!-- Link previews\.[^>]*-->/, `<!-- Link previews: the homepage's own (app/home-shell.ts). -->\n    <meta property="og:url" content="${publicOrigin}/" />\n    <link rel="canonical" href="${publicOrigin}/" />`)
        // Its Markdown twin and structured data (features/pricing/readable.ts; price-pages.ts writes index.md).
        .replace(/<link rel="alternate" type="text\/markdown" href="[^"]*" title="[^"]*" \/>/, `<link rel="alternate" type="text/markdown" href="${publicOrigin}/index.md" title="${productName}, in Markdown" />`)
        .replace('<link rel="manifest" href="/site.webmanifest" />', `<link rel="manifest" href="/site.webmanifest" />\n    <script type="application/ld+json">${jsonLd(structuredData('home'))}</script>`)
        // Nothing is drawn until the whole first screen has arrived (#root follows it; Chrome, other browsers ignore it).
        // The app's stylesheet goes in before the first screen's (boot.js), so it can't restyle it while the app loads.
        .replace('</head>', `  <link rel="expect" href="#root" blocking="render" />\n    <style data-shell-css>${own}${pruned}</style>\n    <style>${faces}</style>\n  </head>`)
        .replace('<div id="root"></div>', `<div id="home-shell">${shell}</div>\n    <div id="root"></div>\n    <script src="${boot}" defer data-css="${styles[0]}" data-preload="${preload.join(' ')}" data-entry="${entry[0]}"></script>`)
      this.emitFile({ type: 'asset', fileName: 'home.html', source: html })
    } },
  }
}

/** The stylesheets the chunk holding `module` loads, its own and its imports'. */
function pageCss(bundle: Rollup.OutputBundle, module: string) {
  const css = new Set<string>(), seen = new Set<string>()
  const visit = (chunk: Rollup.OutputChunk) => {
    if (seen.has(chunk.fileName)) return
    seen.add(chunk.fileName)
    for (const file of chunk.viteMetadata?.importedCss ?? []) css.add(file)
    for (const name of chunk.imports) { const next = bundle[name]; if (next?.type === 'chunk') visit(next) }
  }
  const chunk = Object.values(bundle).find((item): item is Rollup.OutputChunk => item.type === 'chunk' && item.moduleIds.includes(module))
  if (chunk) visit(chunk)
  return [...css]
}

/** The files home.html needs for its first screen, for the cache rules (asset-headers.ts): first in line. Its boot
 *  script, the set's photograph and the tape's still from the build, and its two fonts (public/fonts). */
export const televisionFirstFiles = (files: string[]) => [...files.filter(name => /^assets\/(?:home-boot-[\w-]+\.js|(?:scene|still)-[\w-]+\.webp)$/.test(name)), ...FIRST_FONTS.map(font => `fonts/${font.file}`)]

/** What the rest of the app imports of the homepage (data/context.tsx) and its first picture (App.tsx), as the
 *  television's: an import of either from outside features/home resolves to its stand-in. */
const SWAP = new Map([[at('index.tsx'), at('tv/home.tsx')], [at('first-picture.ts'), at('tv/first-picture.ts')]])
const swap: Plugin = {
  name: 'nightmail:television-swap', enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || importer.startsWith(at('')) || !/(?:^|\/)(?:home|index|first-picture)(?:\.tsx?)?$/.test(source)) return null
    const found = await this.resolve(source, importer, { ...options, skipSelf: true })
    return found && (SWAP.get(found.id) ?? found)
  },
}

/** index.html's description and its link preview's (og.png, below) words: the television's. */
const DESCRIPTION = '$0.20 per 1,000 emails sent via API, after the first 5,000 free every month.'
const ALT = 'A 1980s television on a table in a dark room, playing a price list: “$0.20 per 1,000 emails”, then what 100,000 emails cost on Nightmail ($19) and on SendGrid, Resend, MailerSend, Mailgun, SMTP2GO and Postmark ($34.95 to $115).'
const words: Plugin = {
  name: 'nightmail:television-words',
  transformIndexHtml(html) {
    for (const [meta, value] of [['name="description"', DESCRIPTION], ['property="og:description"', DESCRIPTION], ['name="twitter:description"', DESCRIPTION], ['property="og:image:alt"', ALT], ['name="twitter:image:alt"', ALT]] as const) {
      const pattern = new RegExp(`(<meta ${meta} content=")[^"]*`)
      if (!pattern.test(html)) throw new Error(`index.html has no <meta ${meta}> for the television's words.`)
      html = html.replace(pattern, (_match, start: string) => start + value)
    }
    return html
  },
}

/** The link preview's picture, /og.png (index.html): the television's (tv/og.png) over public/og.png, the factory's, as
 *  brandedBootScript fills theme.js (vite.config.ts): written over the copy in the build, and served by the dev server. */
const picture = (): Plugin => {
  const og = at('tv/og.png')
  let outDir = ''
  return {
    name: 'nightmail:television-picture',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir) },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/og.png') return next()
        response.setHeader('Content-Type', 'image/png')
        response.end(readFileSync(og))
      })
    },
    writeBundle() { writeFileSync(resolve(outDir, 'og.png'), readFileSync(og)) },
  }
}

/** The plugins that make the television the homepage, in homeShell's place (vite.config.ts). */
export const televisionHome = (): Plugin[] => [swap, words, picture(), homeShell()]
