import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runnerImport, type Plugin } from 'vite'
import { productName, publicOrigin } from '../api/src/brand.ts'
import { pruneCss, usedNames } from './critical-css.ts'
import { BASIC, FIRST_FONTS, pageCss, THEME_ATTRIBUTES, WHOLE_FACES } from './price-pages.ts'
import { jsonLd, structuredData } from './src/features/pricing/readable.ts'

// Review builds only (VITE_DESIGN_SHEET=1, as lib/design-sheet.ts): each option of the new homepage (features/home/landing,
// /?home=a, b or c) painted into a file of its own, home-a.html, home-b.html and home-c.html, the way the price pages are
// (price-pages.ts): the option as the app first draws it for a visitor, with the CSS it needs inlined and the first fonts
// preloaded, so it shows before any of the app's code; the boot script (home/shell/boot.js) then starts the app once the
// page is idle, and the app takes the painted copy's place (landing/index.tsx). The review server answers /?home=<option>
// with its file. Any other build writes none of this, and its homepage is home.html as before (home-shell.ts).
const prerenderModule = fileURLToPath(new URL('./src/features/home/landing/prerender.tsx', import.meta.url))
const bootScript = fileURLToPath(new URL('./src/features/home/shell/boot.js', import.meta.url))
const SHELL_CSS = '#landing-shell{position:absolute;top:0;left:0;z-index:2147483000;width:100%}html[data-shell=off] #landing-shell{display:none}body:not(:has(>#root)) #landing-shell{visibility:hidden}'
const VARIANTS = ['a', 'b', 'c'] as const
const NO_CSS: Plugin = { name: 'nightmail:landing-no-css', enforce: 'pre', resolveId: source => source.endsWith('.css') ? '\0landing-no-css' : null, load: id => id === '\0landing-no-css' ? 'export default ""' : null }

export function landingPages(): Plugin {
  let publicDir = '', root = ''
  return {
    name: 'nightmail:landing-pages', apply: 'build', enforce: 'post',
    configResolved(config) { publicDir = config.publicDir; root = config.root },
    generateBundle: { order: 'post', async handler(_options, bundle) {
      if (process.env.VITE_DESIGN_SHEET !== '1') return
      const index = bundle['index.html']
      if (index?.type !== 'asset') return this.error('The homepage options are made from index.html, and the bundle has none.')
      let template = String(index.source)
      const take = (pattern: RegExp) => { const found = [...template.matchAll(pattern)].map(match => match[1]!); template = template.replace(pattern, ''); return found }
      const entry = take(/\s*<script type="module" crossorigin src="([^"]+)"><\/script>/g), preload = take(/\s*<link rel="modulepreload" crossorigin href="([^"]+)">/g), styles = take(/\s*<link rel="stylesheet" crossorigin href="([^"]+)">/g)
      take(/\s*<link rel="preload" href="(\/fonts\/[^"]+)" as="font" type="font\/woff2" crossorigin \/>/g)
      if (entry.length !== 1 || styles.length !== 1 || !template.includes('<div id="root"></div>')) return this.error('index.html is not shaped as the homepage options expect: one entry module and one stylesheet, and #root.')
      const css = [...new Set([styles[0]!.slice(1), ...pageCss(bundle, ['/features/home/landing/index.tsx'])])].map(file => {
        const asset = bundle[file]
        if (asset?.type !== 'asset') this.error(`The homepage options' stylesheet ${file} isn't in the bundle.`)
        return String((asset as { source: string | Uint8Array }).source)
      }).join('')
      const boot = `/${this.getFileName(this.emitFile({ type: 'asset', name: 'home-boot.js', source: readFileSync(bootScript) }))}`
      const fonts = FIRST_FONTS.map(font => ({ ...font, url: `/fonts/${font.file}` }))
      for (const font of fonts) if (!existsSync(resolve(publicDir, font.url.slice(1)))) return this.error(`public${font.url} is missing (features/pricing/fonts/README.md makes it).`)
      const faces = fonts.map(font => `@font-face{font-family:'${font.family}';src:url(${font.url}) format('woff2');font-style:normal;font-weight:${font.weight};font-display:swap;unicode-range:${BASIC}}`).join('')
      // (Its stylesheets are the bundle's, inlined below: in Node a component's CSS import is nothing.)
      const { module: prerender } = await runnerImport<typeof import('./src/features/home/landing/prerender.tsx')>(prerenderModule, { root, configFile: false, logLevel: 'error', plugins: [NO_CSS] })
      const set = (html: string, pattern: RegExp, value: string) => {
        if (!pattern.test(html)) this.error(`index.html has no ${pattern.source} for the homepage options.`)
        return html.replace(pattern, (_match, start: string) => start + value)
      }
      for (const variant of VARIANTS) {
        const shell = prerender.renderLanding(variant)
        let html = template
        html = set(html, /(<title>)[^<]*/, `${productName.toLowerCase()} · Email infrastructure`)
        html = set(html, /(<!-- Link previews\.)[^>]*-->/, ' The homepage\'s own (app/landing-pages.ts). -->')
        html = set(html, /(<meta property="og:type" content="website" \/>)/, `\n    <meta property="og:url" content="${publicOrigin}/" />\n    <link rel="canonical" href="${publicOrigin}/" />`)
        html = set(html, /(<link rel="alternate" type="text\/markdown" href=")[^"]*(?=" title=")/, `${publicOrigin}/index.md`)
        html = set(html, /(<link rel="alternate" type="text\/markdown" href="[^"]*" title=")[^"]*/, `${productName}, in Markdown`)
        html = set(html, /(<meta charset="UTF-8" \/>)/, '\n    <meta name="robots" content="noindex" />')
        html = set(html, /(<link rel="manifest" href="\/site.webmanifest" \/>)/, `\n    <script type="application/ld+json">${jsonLd(structuredData('home'))}</script>`)
        html = set(html, /(<script src="\/theme.js"><\/script>)/, fonts.map(font => `\n    <link rel="preload" href="${font.url}" as="font" type="font/woff2" crossorigin />`).join(''))
        html = set(html, /(<\/title>)/, '\n    <link rel="expect" href="#root" blocking="render" />')
        html = set(html, /(<\/title>)/, `\n    <style data-shell-css>${SHELL_CSS}${pruneCss(css, usedNames(html + shell, THEME_ATTRIBUTES)).replace(WHOLE_FACES, '')}</style>\n    <style>${faces}</style>`)
        // (data-wait="img": the app starts once the page is idle, as the homepage's does after its picture; this page has none.)
        html = html.replace('<div id="root"></div>', `<div id="landing-shell">${shell}</div>\n    <div id="root"></div>\n    <script src="${boot}" defer data-shell="landing-shell" data-press="button" data-wait="img" data-keep=".boot-loader, .landing" data-css="${styles[0]}" data-preload="${preload.join(' ')}" data-entry="${entry[0]}"></script>`)
        this.emitFile({ type: 'asset', fileName: `home-${variant}.html`, source: html })
      }
    } },
  }
}
