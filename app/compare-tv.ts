import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runnerImport, type Plugin, type Rollup } from 'vite'
import { productName, publicOrigin as canonicalOrigin } from '../api/src/brand.ts'
import { pruneCss, usedNames } from './critical-css.ts'
import { PRICE_PAGES } from './src/features/pricing/pages.ts'
import { jsonLd, structuredData } from './src/features/home/tv/readable.ts'
import { billAt, CHANNELS, checkedDay, claim, GROUPS, GUIDE, middle, sizeWords } from './src/features/pricing/tv/channels.ts'
import { formatCount, listOf, type Comparison } from './src/features/pricing/prices.ts'

// Prototypes of the comparison pages with the homepage's television (features/pricing/tv/pages.tsx), in a build with the
// television (VITE_HOME=tv: vite.config.ts), on Nightmail vs Resend: four directions at /compare/resend-tv1 to -tv4, the
// guide the fourth hangs from at /compare, and the second's link-preview card. Each is index.html with the page in it,
// rendered here with React, and the CSS it uses inlined (critical-css.ts: the app's stylesheet, the television's and the
// prototypes', cut down to the page), with none of the app's code: the words and the set arrive with the HTML, and the
// third direction's dial is the one script (dial.js). They ask search engines not to index them, and name the live
// comparison as their canonical page. The guide has its Markdown twin, compare.md.

const at = (path: string) => fileURLToPath(new URL(`./src/features/${path}`, import.meta.url))
const PAGES = at('pricing/tv/pages.tsx'), TV = at('home/tv/tv.tsx')
const minify = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{};])\s*/g, '$1').replace(/,\s+/g, ',').trim()
const attr = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
const BASIC = 'U+0020-007E,U+00A0,U+00A9,U+00AB,U+00AE,U+00B7,U+00BB,U+00D7,U+2010-2027,U+2030,U+2039-203A,U+20AC,U+2122,U+2190-2193,U+2212,U+2713,U+FEFF,U+FFFD'
const FIRST_FONTS = [{ family: 'Inter', file: 'inter-basic.woff2', weight: '100 900' }, { family: 'OpenTUI Mono', file: 'opentui-regular-basic.woff2', weight: '400' }, { family: 'OpenTUI Mono', file: 'opentui-bold-basic.woff2', weight: '700' }]
const WHOLE_FACES = /@font-face\{font-family:(?:Inter|OpenTUI Mono|"Inter"|"OpenTUI Mono");[^}]*\}/g
const THEME_ATTRIBUTES = ['data-theme', 'data-shell', 'data-member', 'data-overview-panel', 'style']
/** Left out of the pages' render: stylesheets (inlined from the bundle instead). */
const renderOnly: Plugin = { name: 'nightmail:compare-tv-render', enforce: 'pre', resolveId: id => /\.css$/.test(id) ? '\0compare-tv-css' : null, load: id => id === '\0compare-tv-css' ? 'export default ""' : null }

export function compareTvPages(): Plugin {
  let root = '', publicDir = ''
  return {
    name: 'nightmail:compare-tv', apply: 'build', enforce: 'post',
    configResolved(config) { root = config.root; publicDir = config.publicDir },
    generateBundle: { order: 'post', async handler(_options, bundle) {
      const index = bundle['index.html']
      if (index?.type !== 'asset') return this.error('The comparison prototypes are made from index.html, and the bundle has none.')
      const source = String(index.source)
      const origin = /<meta property="og:image" content="([^"]+)\/og\.png"/.exec(source)?.[1]
      if (!origin) return this.error('The comparison prototypes need index.html\'s og:image.')
      let template = source
      const take = (pattern: RegExp) => { const found = [...template.matchAll(pattern)].map(match => match[1]!); template = template.replace(pattern, ''); return found }
      take(/\s*<script type="module" crossorigin src="([^"]+)"><\/script>/g); take(/\s*<link rel="modulepreload" crossorigin href="([^"]+)">/g)
      const styles = take(/\s*<link rel="stylesheet" crossorigin href="([^"]+)">/g)
      template = template.replace(/\s*<link rel="preload" href="\/fonts\/[^"]+" as="font" type="font\/woff2" crossorigin \/>/g, '')
      if (styles.length !== 1 || !template.includes('<div id="root"></div>')) return this.error('index.html is not shaped as the comparison prototypes expect.')

      // The CSS: the app's, the television's (as built: the chunk holding tv.tsx) and the prototypes' own.
      const tvChunk = Object.values(bundle).find((item): item is Rollup.OutputChunk => item.type === 'chunk' && item.moduleIds.includes(TV))
      if (!tvChunk) return this.error('The comparison prototypes need the television in the build (VITE_HOME=tv).')
      const sheets = [styles[0]!.slice(1), ...tvChunk.viteMetadata?.importedCss ?? []].map(file => { const asset = bundle[file]; return asset?.type === 'asset' ? String(asset.source) : '' }).join('')
      const css = sheets + minify(readFileSync(at('pricing/tv/compare-tv.css'), 'utf8'))
      const fileOf = (path: string) => {
        const file = Object.values(bundle).find(item => item.type === 'asset' && item.originalFileNames.some(name => name.endsWith(path)))
        if (!file) this.error(`The comparison prototypes need ${path} in the bundle.`)
        return `/${file!.fileName}`
      }
      const scene = fileOf('home/tv/crt/scene.webp')
      const dial = `/${this.getFileName(this.emitFile({ type: 'asset', name: 'compare-dial.js', source: readFileSync(at('pricing/tv/dial.js')) }))}`
      const fonts = FIRST_FONTS.map(font => ({ ...font, url: `/fonts/${font.file}` }))
      for (const font of fonts) if (!existsSync(resolve(publicDir, font.url.slice(1)))) return this.error(`public${font.url} is missing.`)
      const faces = fonts.map(font => `@font-face{font-family:'${font.family}';src:url(${font.url}) format('woff2');font-style:normal;font-weight:${font.weight};font-display:swap;unicode-range:${BASIC}}`).join('')

      const { module: pages } = await runnerImport<typeof import('./src/features/pricing/tv/pages.tsx')>(PAGES, { root, configFile: false, logLevel: 'error', plugins: [renderOnly] })
      const [{ createElement }, { renderToStaticMarkup }] = await Promise.all([import('react'), import('react-dom/server')])
      const real = PRICE_PAGES.find(page => page.path === '/compare/resend')!, c = real.comparison!
      // (Not og/compare-resend-*: scripts/price-cards.mjs deletes every other card under the comparison's own name.)
      const verdictCard = 'og/verdict-resend.jpg'
      type Made = { file: string; title: string; description: string; canonical: string; card: { file: string; alt: string }; element: Parameters<typeof renderToStaticMarkup>[0]; data: object | null; set: boolean; markdown?: string }
      const v = pages.verdictWords(c)
      const made: Made[] = [
        { file: 'compare/resend-tv1.html', element: createElement(pages.ChannelPage, { c }), set: true },
        { file: 'compare/resend-tv2.html', element: createElement(pages.VerdictPage, { c }), set: false, card: { file: verdictCard, alt: `${v.ours} ${v.theirs} ${v.at}` } },
        { file: 'compare/resend-tv3.html', element: createElement(pages.DialPage, { c, script: dial }), set: true },
        { file: 'compare/resend-tv4.html', element: createElement(pages.GuideComparisonPage, { c }), set: false },
      ].map((page, i) => ({ title: real.title, description: real.description, canonical: canonicalOrigin + real.path, card: real.card, data: withQuestions(structuredData(real), pages.questions(c), i === 3 ? c : null), ...page }))
      const checked = pages.guideChecked()
      made.push({ file: 'compare.html', element: createElement(pages.GuidePage), set: true, title: 'Email API alternatives and pricing compared',
        description: `${productName} beside ${listOf(GROUPS.map(group => `${CHANNELS.filter(channel => channel.comparison.focus === group.focus).length} ${group.noun}`))}: a month's price on each, from its own pricing page, read ${checked}.`,
        canonical: canonicalOrigin + '/compare', card: { file: 'og.png', alt: '' }, data: guideData(checked), markdown: 'compare.md' })
      made.push({ file: 'compare/resend-tv2-card.html', element: createElement(pages.VerdictCard, { c }), set: false, title: real.title, description: real.description, canonical: canonicalOrigin + real.path, card: real.card, data: null })

      for (const page of made) {
        const body = renderToStaticMarkup(page.element).replace(/\/src\/features\/home\/tv\/crt\/(scene|knob)\.webp/g, (_m, name: string) => fileOf(`home/tv/crt/${name}.webp`))
        let html = template
        const set = (pattern: RegExp, value: string) => {
          if (!pattern.test(html)) this.error(`index.html has no ${pattern.source} for ${page.file}.`)
          html = html.replace(pattern, (_match, start: string) => start + value)
        }
        const title = `${page.title} · ${productName.toLowerCase()}`
        set(/(<title>)[^<]*/, attr(title))
        for (const name of ['name="description"', 'property="og:description"', 'name="twitter:description"']) set(new RegExp(`(<meta ${name} content=")[^"]*`), attr(page.description))
        for (const name of ['property="og:title"', 'name="twitter:title"']) set(new RegExp(`(<meta ${name} content=")[^"]*`), attr(title))
        for (const name of ['property="og:image"', 'name="twitter:image"']) set(new RegExp(`(<meta ${name} content=")[^"]*`), attr(`${origin}/${page.card.file}`))
        for (const name of ['property="og:image:alt"', 'name="twitter:image:alt"']) set(new RegExp(`(<meta ${name} content=")[^"]*`), attr(page.card.alt))
        if (page.card.file.endsWith('.jpg')) set(/(<meta property="og:image:type" content=")[^"]*/, 'image/jpeg')
        set(/(<!-- Link previews\.)[^>]*-->/, ' A comparison prototype\'s (app/compare-tv.ts). -->')
        set(/(<meta property="og:type" content="website" \/>)/, `\n    <meta property="og:url" content="${attr(page.canonical)}" />\n    <link rel="canonical" href="${attr(page.canonical)}" />`)
        set(/(<link rel="alternate" type="text\/markdown" href=")[^"]*(?=" title=")/, attr(page.markdown ? `${canonicalOrigin}/${page.markdown}` : `${page.canonical}.md`))
        if (!html.includes('<meta name="robots"')) set(/(<meta charset="UTF-8" \/>)/, '\n    <meta name="robots" content="noindex" />')
        if (page.data) set(/(<link rel="manifest" href="\/site.webmanifest" \/>)/, `\n    <script type="application/ld+json">${jsonLd(page.data)}</script>`)
        set(/(<script src="\/theme.js"><\/script>)/, [
          ...fonts.map(font => `<link rel="preload" href="${font.url}" as="font" type="font/woff2" crossorigin />`),
          ...page.set ? [`<link rel="preload" href="${scene}" as="image" fetchpriority="high" />`] : [],
        ].map(line => `\n    ${line}`).join(''))
        // Drawn once the whole page has arrived (Chrome; others ignore it), so nothing grows as the rest streams in.
        set(/(<\/title>)/, '\n    <link rel="expect" href="#root" blocking="render" />')
        set(/(<\/title>)/, `\n    <style>${pruneCss(css, usedNames(html + body, THEME_ATTRIBUTES)).replace(WHOLE_FACES, '')}</style>\n    <style>${faces}</style>`)
        html = html.replace('<div id="root"></div>', `${body}\n    <div id="root"></div>`)
        this.emitFile({ type: 'asset', fileName: page.file, source: html })
        if (page.markdown) this.emitFile({ type: 'asset', fileName: page.markdown, source: guideMarkdown(checked) })
      }
    } },
  }
}

const home = { '@type': 'ListItem', position: 1, name: productName, item: `${canonicalOrigin}/` }, hub = { '@type': 'ListItem', position: 2, name: 'Compare', item: `${canonicalOrigin}/compare` }
/** A comparison's structured data with the questions it shows (FAQPage) and, in the guide's direction, where it sits
 *  (BreadcrumbList: Home › Compare › the vendor). */
function withQuestions(data: object, questions: { question: string; answer: string }[], crumb: Comparison | null) {
  const graph = (data as { '@graph': object[] })['@graph']
  graph.push({ '@type': 'FAQPage', mainEntity: questions.map(item => ({ '@type': 'Question', name: item.question, acceptedAnswer: { '@type': 'Answer', text: item.answer } })) })
  if (crumb) graph.push({ '@type': 'BreadcrumbList', itemListElement: [home, hub, { '@type': 'ListItem', position: 3, name: crumb.offer.vendor, item: canonicalOrigin + crumb.path }] })
  return data
}
/** The guide's structured data (the SEO audit's spec): the page as a collection, the list of the comparisons in its order,
 *  and its place (Home › Compare). */
function guideData(checked: string) {
  const url = `${canonicalOrigin}/compare`
  return { '@context': 'https://schema.org', '@graph': [
    { '@type': 'CollectionPage', '@id': url, url, name: 'Email API alternatives and pricing compared', inLanguage: 'en', dateModified: CHANNELS.map(channel => channel.comparison.offer.checked).sort().at(-1), mainEntity: { '@id': `${url}#list` }, description: `${productName} beside ${CHANNELS.length} email services, read ${checked}.` },
    { '@type': 'ItemList', '@id': `${url}#list`, numberOfItems: CHANNELS.length, itemListElement: CHANNELS.map((channel, i) => ({ '@type': 'ListItem', position: i + 1, name: channel.comparison.title, url: canonicalOrigin + channel.comparison.path })) },
    { '@type': 'BreadcrumbList', itemListElement: [home, { ...hub }] },
  ] }
}
/** The guide in Markdown: the ranked table and each group's listings, as the page has them. */
function guideMarkdown(checked: string) {
  const ranked = GUIDE[0]!
  const listing = (c: Comparison) => { const b = billAt(c, middle(c)); return `- [${c.title}](${canonicalOrigin}${c.path}.md): ${sizeWords(c, b.size)}, ${productName} ${b.ours}, ${c.offer.vendor} ${b.theirs ?? 'no price read'}${b.plan ? ` (${b.plan})` : ''}. ${c.lead} ${claim(c).replaceAll('\u00a0', ' ')}, read ${checkedDay(c)}.` }
  return [`# ${productName} compared with ${CHANNELS.length} email services`, `Canonical page: ${canonicalOrigin}/compare`,
    `What a month costs on ${productName} and on each service, from each service’s own pricing page, last read ${checked}: list prices before tax, monthly billing, the cheapest plan that holds the size or pay-as-you-go where that costs less.`,
    `## Cheapest at ${formatCount(ranked.columns[1]!)} emails a month? ${ranked.rows.length} sending APIs priced`, `${productName} costs less than each of them at every size shown, as read on each one’s own pricing page on ${checked}. In ${ranked.unit}; a dash: no plan priced at that size.`,
    [`| Service | ${ranked.columns.map(formatCount).join(' | ')} |`, `| --- | ${ranked.columns.map(() => '---:').join(' | ')} |`, `| ${productName} | ${ranked.ours.join(' | ')} |`,
      ...ranked.rows.map(row => `| [${row.channel.comparison.offer.vendor}](${canonicalOrigin}${row.channel.comparison.path}.md) | ${row.bills.map(bill => bill.theirs ?? '—').join(' | ')} |`)].join('\n'),
    ...GROUPS.flatMap(group => [`## ${group.title}`, CHANNELS.filter(channel => channel.comparison.focus === group.focus).map(channel => listing(channel.comparison)).join('\n')]),
    'Product names belong to their owners and only identify their products. Nightmail isn’t affiliated with them.'].join('\n\n') + '\n'
}
