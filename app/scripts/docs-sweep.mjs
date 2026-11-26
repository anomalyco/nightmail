// Every docs page painted from its HTML (app/site-pages.ts, features/docs/prerender.tsx) says, word for word, what the
// app's page says once it takes over, and the reader keeps their place (the page's scroll and the contents'): the
// overview, the guides and every operation's reference, served by the CLS fixture at the address the build painted them
// for. The CLS gate measures a few of them in full (scripts/cls.mjs); this reads all of them, in the merge queue (ci.yml,
// the cls job's `alone` shard), so a change anywhere the docs draw from can't land with a painted page the app disagrees with.
//
//   node scripts/docs-sweep.mjs                    every page at 1440 × 900, light; the overview and guides also dark and at 390 × 844
//   DOCS_SWEEP_ALL=1 node scripts/docs-sweep.mjs   every page in all four
//   CLS_CHROME=<path>  Chrome executable; otherwise the installed Google Chrome. CLS_PG_URL as for scripts/cls.mjs.
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { start } from './cls-fixture.mjs'

const app = join(dirname(fileURLToPath(import.meta.url)), '..'), repo = join(app, '..'), dist = join(app, 'dist')
const painted = /<script src="\/theme\.js"[^>]* data-origin="http:\/\/127\.0\.0\.1:(\d+)"/.exec(readFileSync(join(dist, 'docs.html'), 'utf8'))
if (!painted) throw new Error('dist/docs.html isn\'t painted for the fixture: build with VITE_PUBLIC_URL=http://127.0.0.1:47173.')
const pages = name => readdirSync(join(dist, name)).filter(file => file.endsWith('.html')).map(file => `/${name}/${file.slice(0, -'.html'.length)}`)
const guides = ['/docs', ...pages('docs')], reference = pages('docs/api')
const views = [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]
const all = process.env.DOCS_SWEEP_ALL === '1'
const lanes = 6

const started = Date.now()
const browser = await chromium.launch({ ...process.env.CLS_CHROME ? { executablePath: process.env.CLS_CHROME } : { channel: 'chrome' }, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] })
const fx = await start(repo, { dist: 'app/dist', port: Number(painted[1]) })
const problems = []
let read = 0, slowest = 0
// What a reader has in front of them: the page's words (the frame, menus and contents too) and where it and its contents are scrolled.
const place = page => page.evaluate(() => {
  const root = document.getElementById('page-shell') ?? document.querySelector('#root > *')
  return { words: root?.innerText.replace(/\s+/g, ' ').trim() ?? '', page: scrollY, contents: Math.round(root?.querySelector('.ui-subnav__scroll')?.scrollTop ?? -1) }
})
try {
  for (const [n, [width, scheme]] of views.entries()) {
    const paths = all || n === 0 ? [...guides, ...reference] : guides, view = `${width} ${scheme}`
    await Promise.all(Array.from({ length: lanes }, async (_, lane) => {
      const phone = width < 600
      const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, colorScheme: scheme })
      const page = await context.newPage()
      let path = '', failed = []
      page.on('pageerror', error => problems.push(`${path} (${view}): ${error.message.split('\n')[0]}`))
      // What the page asked for that didn't come, named when it isn't painted or the app doesn't take over.
      page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('/v1/me')) failed.push(`${response.status()} ${new URL(response.url()).pathname}`) })
      page.on('requestfailed', request => failed.push(`${request.failure()?.errorText ?? 'failed'} ${new URL(request.url()).pathname}`))
      const why = async () => { const state = await page.evaluate(() => ({ shell: document.documentElement.dataset.shell ?? 'on', hint: localStorage.getItem('nightmail.session') })).catch(() => ({})); return `shell ${state.shell}, session hint ${state.hint}${failed.length ? `; ${failed.slice(0, 4).join(', ')}` : ''}` }
      for (let i = lane; i < paths.length; i += lanes) {
        path = paths[i], failed = []
        const response = await page.goto(fx.origin + path, { waitUntil: 'load', timeout: 30_000 })
        if (!await page.evaluate(() => !!document.getElementById('page-shell'))) { problems.push(`${path} (${view}): not painted (HTTP ${response?.status()}; ${await why()})`); continue }
        const before = await place(page), pressed = Date.now()
        await page.keyboard.press('Shift')
        if (!await page.waitForFunction(() => !document.getElementById('page-shell'), null, { timeout: 30_000 }).then(() => true, () => false)) { problems.push(`${path} (${view}): the app never took over (${await why()})`); continue }
        slowest = Math.max(slowest, Date.now() - pressed)
        const after = await place(page)
        if (after.words !== before.words) {
          let at = 0
          while (after.words[at] === before.words[at]) at++
          problems.push(`${path} (${view}): the words differ at character ${at}: “…${before.words.slice(Math.max(0, at - 40), at + 60)}…” painted, “…${after.words.slice(Math.max(0, at - 40), at + 60)}…” in the app`)
        }
        if (after.page !== before.page || Math.abs(after.contents - before.contents) > 1) problems.push(`${path} (${view}): scrolled to ${before.page} (contents ${before.contents}) painted, ${after.page} (contents ${after.contents}) in the app`)
        read++
      }
      await context.close()
    }))
  }
} finally {
  await browser.close()
  await fx.stop()
}
console.log(`${read} docs pages read, painted and in the app (${guides.length} guides and overview, ${reference.length} reference pages${all ? ', each in four views' : ''}); slowest takeover ${slowest} ms; ${((Date.now() - started) / 1000).toFixed(0)} s`)
for (const problem of problems) console.log(`  ${problem}`)
if (problems.length) process.exitCode = 1
