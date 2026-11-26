import { createHash } from 'node:crypto'
import { SECURITY_HEADERS } from '../api/src/security-headers.ts'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { MAX_RULES, withFileRules } from './asset-headers.ts'
import { renderLegal } from './legal-markdown.ts'
import { homeFirstFiles, homeShell } from './home-shell.ts'
import { televisionFirstFiles, televisionHome } from './home-tv.ts'
import { priceFirstFiles, pricePages } from './price-pages.ts'
import * as televisionWords from './src/features/home/tv/readable.ts'
import { headerPrefix, publicOrigin as hostedOrigin } from '../api/src/brand.ts'

// @react-email/editor's own "react-email" imports resolve to a slim shim (src/features/campaigns/react-email-shim.ts
// explains why); everything else, the shim included, gets the real package.
const reactEmailShim = fileURLToPath(new URL('./src/features/campaigns/react-email-shim.ts', import.meta.url))
const slimReactEmail: Plugin = {
  name: 'nightmail:slim-react-email', enforce: 'pre',
  resolveId(source, importer) { return source === 'react-email' && importer?.includes('/node_modules/@react-email/editor/') ? reactEmailShim : null },
}

// dist/_headers for Cloudflare: public/_headers, then a cache rule for each built file under assets/ and each font
// (asset-headers.ts explains why they are listed by name). The files every page loads come first, because past
// Cloudflare's rule limit the rest only revalidate.
const fileHeaders = (homeFirst: (files: string[]) => string[]): Plugin => {
  let publicDir = '', outDir = ''
  return {
    name: 'nightmail:file-headers', apply: 'build',
    configResolved(config) { publicDir = config.publicDir; outDir = resolve(config.root, config.build.outDir) },
    writeBundle(_options, bundle) {
      const first = new Set<string>()
      const add = (name: string) => {
        const file = bundle[name]
        if (first.has(name) || !file) return
        first.add(name)
        if (file.type === 'chunk') for (const dependency of [...file.imports, ...file.viteMetadata?.importedCss ?? []]) add(dependency)
      }
      // The dashboard's entry, then what the homepage's first screen loads (home-shell.ts, or home-tv.ts), then the price pages' (price-pages.ts).
      for (const file of Object.values(bundle)) if (file.type === 'chunk' && file.isEntry && file.name === 'index') add(file.fileName)
      for (const file of homeFirst(Object.keys(bundle))) if (file.startsWith('fonts/')) first.add(file); else add(file)
      for (const file of priceFirstFiles(Object.keys(bundle))) add(file)
      const fonts = readdirSync(resolve(publicDir, 'fonts')).sort().map(name => `fonts/${name}`)
      const { headers, uncached } = withFileRules(readFileSync(resolve(publicDir, '_headers'), 'utf8'), [...first, ...fonts, ...Object.keys(bundle).sort()])
      writeFileSync(resolve(outDir, '_headers'), headers)
      if (uncached.length) this.warn(`${uncached.length} files have no cache rule and revalidate on every load (Cloudflare reads ${MAX_RULES} rules, and a rule needs a plain file name): ${uncached.join(', ')}`)
    },
  }
}

// The legal pages' Markdown becomes { title, description, updated, effective, html, headings } at build time
// (legal-markdown.ts), so the page ships HTML and no Markdown parser.
const legalMarkdown: Plugin = {
  name: 'nightmail:legal-markdown',
  transform(source, id) {
    if (!id.endsWith('.md')) return null
    return { code: `export default ${JSON.stringify(renderLegal(source, id))}`, map: null }
  },
}

// The commit a build was made from, recorded with each UI note (features/ui-notes). Only that lazy chunk reads it.
const buildSha = (() => {
  const named = process.env.NIGHTMAIL_BUILD_SHA ?? process.env.GITHUB_SHA
  if (named) return named.slice(0, 12)
  try { return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return 'unknown' }
})()

// Link-preview images need an absolute URL: the deploy sets VITE_PUBLIC_URL per stage; other builds name the hosted origin.
// A stage on another host than the hosted site's (the dev stage) also asks search engines to leave its pages out: they
// are the hosted site's pages over again, and a search result should open the real one. home.html and the price pages
// are made from index.html, so they ask too.
const stageOrigin = (process.env.VITE_PUBLIC_URL || hostedOrigin).replace(/\/$/, '')
const publicOrigin: Plugin = {
  name: 'nightmail:public-origin',
  transformIndexHtml(html) {
    html = html.replaceAll('%PUBLIC_ORIGIN%', stageOrigin)
    if (stageOrigin === hostedOrigin || html.includes('<meta name="robots"')) return html
    if (!html.includes('<meta charset="UTF-8" />')) throw new Error('index.html has no <meta charset="UTF-8" /> to put the stage\'s robots line after.')
    return html.replace('<meta charset="UTF-8" />', '<meta charset="UTF-8" />\n    <meta name="robots" content="noindex" />')
  },
}

// public/theme.js runs before the app's modules and is served as written, so the request header names it shares with the
// app and the API come from brand.ts here: %HEADER_PREFIX% becomes X-Nightmail-, in the dev server and in the build.
const brandedBootScript = (): Plugin => {
  const file = 'theme.js'
  let publicDir = '', outDir = ''
  const filled = () => readFileSync(resolve(publicDir, file), 'utf8').replaceAll('%HEADER_PREFIX%', headerPrefix)
  return {
    name: 'nightmail:branded-boot-script',
    configResolved(config) { publicDir = config.publicDir; outDir = resolve(config.root, config.build.outDir) },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== `/${file}`) return next()
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        response.end(filled())
      })
    },
    writeBundle() { writeFileSync(resolve(outDir, file), filled()) },
  }
}

// Inject before homeShell/pricePages copy index.html, so a static document needs no React for collection.
const publicBeacon: Plugin = {
  name: 'nightmail:public-beacon',
  transformIndexHtml(html) {
    const js = readFileSync(new URL('./public-beacon.js', import.meta.url), 'utf8').trim()
    const hash = "'sha256-" + createHash('sha256').update(js).digest('base64') + "'"
    if (Buffer.byteLength(js) >= 1024 || !SECURITY_HEADERS['Content-Security-Policy']!.includes(hash)
      || !readFileSync(new URL('./public/_headers', import.meta.url), 'utf8').includes(hash)) throw new Error('Check public beacon size and CSP hash.')
    return html.replace('</body>', '<script>' + js + '</script></body>')
  },
  // Every page the build writes carries it byte for byte (its CSP hash allows only these bytes), the pages made from
  // index.html included (home-shell.ts, price-pages.ts; inlineScriptsKept checks that they change nothing of it).
  writeBundle(_options, bundle) {
    const tag = '<script>' + readFileSync(new URL('./public-beacon.js', import.meta.url), 'utf8').trim() + '</script>'
    const missing = Object.values(bundle).filter(file => file.type === 'asset' && file.fileName.endsWith('.html') && !String(file.source).includes(tag)).map(file => file.fileName)
    if (missing.length) throw new Error(`The public beacon is missing or changed in ${missing.join(', ')}: its CSP hash would refuse it.`)
  },
}

// Every page made from index.html (home.html, the price pages) keeps each script index.html carries inline byte for
// byte: the CSP allows an inline script by the hash of its exact bytes, so one rewritten on the way would be refused.
const inlineScriptsKept = (): Plugin => ({
  name: 'nightmail:inline-scripts-kept', apply: 'build', enforce: 'post',
  generateBundle: { order: 'post', handler(_options, bundle) {
    const source = (name: string) => { const file = bundle[name]; return file?.type === 'asset' ? String(file.source) : '' }
    const scripts = [...source('index.html').matchAll(/<script>[\s\S]*?<\/script>/g)].map(match => match[0])
    for (const name of Object.keys(bundle).filter(name => name.endsWith('.html') && name !== 'index.html'))
      for (const script of scripts) if (!source(name).includes(script)) this.error(`${name} lost or changed index.html's inline script ${script.slice(0, 60)}…: its CSP hash would refuse it.`)
  } },
})

// The homepage a build has (features/home): the factory's, or with VITE_HOME=tv the television (home-tv.ts says what that
// changes). The deploy sets it per stage (.github/workflows/deploy.yml). The dev server also reads it from app/.env.local;
// a build reads only its own environment, so an env file left on a machine can't change what a build ships.
const isTelevision = (command: string, mode: string) => (command === 'serve' ? loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_HOME') : process.env).VITE_HOME === 'tv'
// The price pages' next version (features/pricing/live.ts, PRICE_PAGES_VERDICT): VITE_PRICE_PAGES=verdict, which the deploy
// sets for the dev stage only, read the same way, and written into the app's code as a literal, so an env file can't set
// it for a build and a build without it drops what it gates.
const isVerdict = (command: string, mode: string) => (command === 'serve' ? loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_PRICE_PAGES') : process.env).VITE_PRICE_PAGES === 'verdict'

export default defineConfig(({ command, mode }) => {
  const tv = isTelevision(command, mode)
  return {
    // VITE_DESIGN_SHEET is always a literal, set or not, so a build without it folds the design sheet's gate to false and
    // drops its chunk (src/lib/design-sheet.ts).
    define: { __NIGHTMAIL_BUILD__: JSON.stringify(buildSha), 'import.meta.env.VITE_DESIGN_SHEET': JSON.stringify(process.env.VITE_DESIGN_SHEET ?? ''), __NIGHTMAIL_PRICE_PAGES__: JSON.stringify(isVerdict(command, mode)) },
    // (The homepage's station kit is inlined whatever its size: it is one lazily loaded stylesheet, features/home/machines.tsx.)
    build: { assetsInlineLimit: file => file.includes('/features/home/kit/') || undefined, rolldownOptions: { input: { index: fileURLToPath(new URL('./index.html', import.meta.url)) } } },
    plugins: [slimReactEmail, legalMarkdown, react(), fileHeaders(tv ? televisionFirstFiles : homeFirstFiles), publicOrigin, brandedBootScript(), publicBeacon, ...tv ? televisionHome() : [homeShell()], pricePages(tv ? televisionWords : undefined), inlineScriptsKept()],
    server: {
      host: '127.0.0.1', port: 5173, strictPort: true,
      proxy: Object.fromEntries(['/v1', '/api/auth', '/mcp', '/.well-known', '/unsubscribe', '/health', '/openapi.json', '/internal'].map(path => [path, {target: 'http://127.0.0.1:8793', changeOrigin: false}])),
    },
  }
})
