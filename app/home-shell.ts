import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { productName, publicOrigin } from '../api/src/brand.ts'
import type { Format, Manifest } from './src/features/home/factory/manifest.ts'
import { frameOf, UPRIGHT } from './src/features/home/frame.ts'
import { toneVars } from './src/features/home/tones.ts'
import { jsonLd, structuredData } from './src/features/pricing/readable.ts'

// home.html: the homepage's first screen, painted from the HTML alone. A hosted installation's Worker answers "/" with
// it (api/src/worker.ts); every other path, and "/" on a self-hosted one, gets index.html as before. It is index.html
// with the factory's hero in it (its frame laid out by factory-home.css, inlined): a small, soft copy of the poster
// first (first.avif, about 10 kB), then the poster itself as the page loads it (first-picture.ts), so the first picture
// is fetched with the HTML and nothing else competes with it: the app's stylesheet and modules are not in the page,
// and home-boot.js starts them once the poster is in (features/home/shell/boot.js). The app's homepage then takes the
// first screen's place (factory-home.tsx). The words on it are the page's own (factory-home.tsx, SignInConsent).

const at = (path: string) => fileURLToPath(new URL(`./src/features/home/${path}`, import.meta.url))
const MANIFESTS = { desktop: JSON.parse(readFileSync(at('factory/manifest.json'), 'utf8')), phone: JSON.parse(readFileSync(at('factory/phone/manifest.json'), 'utf8')) } as Record<Format, Manifest>
const css = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{};])\s*/g, '$1').replace(/,\s+/g, ',').trim()
const attr = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
const ARROW = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="srt-cta-arrow" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>'
const BUSY = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="hs-busy" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>'
/** An image that is never fetched: a picture's choice where the other frame is shown. */
const NOTHING = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='
const POSTERS: Record<Format, { avif: [number, string][]; jpeg: [number, string][]; src: string; first: string }> = {
  desktop: { avif: [[960, 'factory/poster-960.avif'], [1280, 'factory/poster-1280.avif'], [1920, 'factory/poster-1920.avif']], jpeg: [[1280, 'factory/poster-1280.jpg'], [1920, 'factory/poster.jpg']], src: 'factory/poster.jpg', first: 'factory/first.avif' },
  phone: { avif: [[640, 'factory/phone/poster-640.avif'], [828, 'factory/phone/poster-828.avif'], [1080, 'factory/phone/poster-1080.avif']], jpeg: [[828, 'factory/phone/poster-828.jpg'], [1080, 'factory/phone/poster.jpg']], src: 'factory/phone/poster.jpg', first: 'factory/phone/first.avif' },
}

export function homeShell(): Plugin {
  return {
    name: 'nightmail:home-shell', apply: 'build', enforce: 'post',
    generateBundle: { order: 'post', handler(_options, bundle) {
      const index = bundle['index.html']
      if (index?.type !== 'asset') return this.error('home.html is made from index.html, and the bundle has none.')
      const url = (path: string) => {
        const file = Object.values(bundle).find(item => item.type === 'asset' && item.originalFileNames.some(name => name.endsWith(`features/home/${path}`)))
        if (!file) this.error(`home.html needs ${path} in the bundle (first-picture.ts imports it).`)
        return `/${file!.fileName}`
      }
      const emit = (name: string, path: string) => `/${this.getFileName(this.emitFile({ type: 'asset', name, source: readFileSync(at(path)) }))}`
      const font = emit('inter-shell.woff2', 'shell/inter-shell.woff2'), boot = emit('home-boot.js', 'shell/boot.js')
      const first = { desktop: emit('first.avif', POSTERS.desktop.first), phone: emit('first.avif', POSTERS.phone.first) }

      // The app's files, out of the page: home-boot.js starts them.
      let html = String(index.source)
      const take = (pattern: RegExp) => { const found = [...html.matchAll(pattern)].map(match => match[1]!); html = html.replace(pattern, ''); return found }
      const entry = take(/\s*<script type="module" crossorigin src="([^"]+)"><\/script>/g), preload = take(/\s*<link rel="modulepreload" crossorigin href="([^"]+)">/g), styles = take(/\s*<link rel="stylesheet" crossorigin href="([^"]+)">/g)
      take(/\s*<link rel="preload" href="(\/fonts\/[^"]+)" as="font" type="font\/woff2" crossorigin \/>/g)
      if (entry.length !== 1 || styles.length !== 1 || !html.includes('<script src="/theme.js"></script>') || !html.includes('<div id="root"></div>')) return this.error('index.html is not shaped as home.html expects: one entry module and one stylesheet, theme.js, #root.')

      const floor = { light: toneVars(false)['--srt-floor'], dark: toneVars(true)['--srt-floor'] }
      const style = css(`:root{--hs-floor-light:${floor.light};--hs-floor-dark:${floor.dark}}` + readFileSync(at('factory-home.css'), 'utf8') + readFileSync(at('shell/shell.css'), 'utf8').replace('%FONT%', font).replace('%UPRIGHT%', UPRIGHT))
      const variant = (format: Format) => {
        const m = MANIFESTS[format], { vars, button } = frameOf(m, format), p = POSTERS[format]
        const set = (list: [number, string][]) => list.map(([width, path]) => `${url(path)} ${width}w`).join(', ')
        const box = Object.entries(button).map(([key, value]) => `${key}:${value}`).join(';')
        // The soft copy, then the poster over it (fetched after it). The tall frame's pictures are fetched only where the
        // window is upright, the wide one's only where it isn't (another frame's picture is NOTHING).
        const here = format === 'phone' ? `media="${UPRIGHT}" ` : '', elsewhere = format === 'phone' ? '' : `<source media="${UPRIGHT}" srcset="${NOTHING}">`
        const size = `alt="" width="${m.width}" height="${m.height}"`
        const soft = `${elsewhere}<source ${here}type="image/avif" srcset="${first[format]}"><img class="hs-first" src="${NOTHING}" ${size} fetchpriority="high">`
        const full = `${elsewhere}<source ${here}type="image/avif" srcset="${set(p.avif)}" sizes="100vw"><source ${here}srcset="${set(p.jpeg)}" sizes="100vw">`
          + `<img class="fac-poster" src="${format === 'phone' ? NOTHING : url(p.src)}" ${size} fetchpriority="low">`
        return `<div class="srt-page fac-page" data-format="${format}" data-visitor><main><section class="fac-hero" aria-label="Pricing">`
          + '<h1 class="sr-only">$0.20 per 1,000 emails, sent or received via API.</h1><p class="sr-only">Free every month: 5,000 emails sent and 20,000 received. Responds in about 100 ms.</p>'
          + `<div class="fac-stage" style="${attr(Object.entries(vars).map(([key, value]) => `${key}:${value}`).join(';'))}"><div class="fac-frame"><picture>${soft}</picture><picture>${full}</picture>`
          + `<button type="button" class="fac-cta hs-visitor" data-cta="sign-in" style="${box}"><span class="srt-cta-label">Get started${ARROW}${BUSY}</span></button>`
          + `<a class="fac-cta hs-member" href="/overview" style="${box}"><span class="srt-cta-label">Open dashboard${ARROW}</span></a></div></div>`
          + '<div class="fac-under"><p class="sign-in-consent fac-consent">By continuing you accept the <a href="/legal/terms">Terms</a>, <a href="/legal/privacy">Privacy Policy</a> and product email (unsubscribe any time).<span aria-hidden="true"> · </span><a href="/docs">API docs</a></p></div>'
          + '</section></main></div>'
      }
      html = html
        .replace('<script src="/theme.js"></script>', '<script src="/theme.js" data-home></script>')
        .replace(/<title>[^<]*<\/title>/, `<title>${productName.toLowerCase()} · Email infrastructure</title>`)
        // (Served only at the hosted site's "/", so it can name its address: the sitemap lists it, app/price-pages.ts.)
        .replace(/<!-- Link previews\.[^>]*-->/, `<!-- Link previews: the homepage's own (app/home-shell.ts). -->\n    <meta property="og:url" content="${publicOrigin}/" />\n    <link rel="canonical" href="${publicOrigin}/" />`)
        // Its Markdown twin and structured data (features/pricing/readable.ts; price-pages.ts writes index.md).
        .replace(/<link rel="alternate" type="text\/markdown" href="[^"]*" title="[^"]*" \/>/, `<link rel="alternate" type="text/markdown" href="${publicOrigin}/index.md" title="${productName}, in Markdown" />`)
        .replace('<link rel="manifest" href="/site.webmanifest" />', `<link rel="manifest" href="/site.webmanifest" />\n    <script type="application/ld+json">${jsonLd(structuredData('home'))}</script>`)
        .replace('</head>', `  <link rel="preload" href="${font}" as="font" type="font/woff2" crossorigin />\n    <style>${style}</style>\n  </head>`)
        .replace('<div id="root"></div>', `<div id="home-shell">${variant('desktop')}${variant('phone')}</div>\n    <div id="root"></div>\n    <script src="${boot}" defer data-css="${styles[0]}" data-preload="${preload.join(' ')}" data-entry="${entry[0]}"></script>`)
      this.emitFile({ type: 'asset', fileName: 'home.html', source: html })
    } },
  }
}
/** The files home.html needs for its first screen, for the cache rules (asset-headers.ts): first in line. */
export const homeFirstFiles = (files: string[]) => files.filter(name => /^assets\/(home-boot|inter-shell|home)-|^assets\/(first|poster)-[\w-]+\.(avif|jpg)$/.test(name))
