import { useEffect, useState, useSyncExternalStore } from 'react'

// One sandboxed frame per column of the preview (the email as sent and each emulated client). A frame follows the
// preview contract: srcdoc in an iframe with sandbox="" (no scripts, an opaque origin) and a CSP that blocks remote
// loads (the original allows https images, minus tracking pixels: components/EmailPreview.tsx). An opaque frame can't
// report its size, so each document is first loaded off screen in a copy that runs no scripts either but shares the
// page's origin (sandbox="allow-same-origin"), and read once its images and fonts are in: its height, and the span its
// content takes. The frame then takes that height, so the whole email shows and nothing scrolls inside it, and is
// cropped to that span (the empty margins around a 600 px email in an 800 px window) and scaled to fit its column.
export const FRAME_WIDTH = { desktop: 800, mobile: 390 } as const
export type FrameDevice = keyof typeof FRAME_WIDTH
const GUARD = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer"><style>html{scrollbar-width:none}html::-webkit-scrollbar{display:none}</style>`
/** An emulated client's HTML (the API's previewEmail) as a frame document, with the guard first in its head. */
export const frameDocument = (html: string) => /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, head => head + GUARD) : GUARD + html

/** A document laid out at a width: `width` it renders at (wider than asked when its content is), the `height` of its
 *  content, and the span [left, right) the frame shows: its content with a margin, or all of it. */
export type FrameSize = { width: number; height: number; left: number; right: number }
export const shownWidth = (size: FrameSize) => size.right - size.left

const MAX_WIDTH = 1600, MARGIN = 24, MIN_SPAN = 400
// Past SLOW_MS a frame shows what has loaded and grows when the rest arrives; past GIVE_UP_MS that is final.
const SLOW_MS = 3000, GIVE_UP_MS = 20_000
const REPLACED = /^(IMG|SVG|VIDEO|CANVAS|HR|INPUT|TEXTAREA|SELECT|BUTTON|PICTURE|OBJECT)$/i
const clear = (color: string) => color === 'transparent' || /^rgba\(.*,\s*0\)$/.test(color)

// The span of what paints: text, images and rules, and boxes whose background differs from what is behind them (a white
// card on a grey wrapper) or that have a border or shadow. A box that spans the whole width (a coloured wrapper) is
// background, not content. Margins are cropped to MARGIN on each side; a span narrower than MIN_SPAN widens.
function span(page: Document, width: number): [number, number] {
  const view = page.defaultView, body = page.body
  if (!view || !body) return [0, width]
  const canvas = view.getComputedStyle(page.documentElement).backgroundColor, base = clear(canvas) ? 'rgb(255, 255, 255)' : canvas
  const behind = new Map<Element, string>()
  let left = Infinity, right = -Infinity
  const take = (rect: DOMRect) => { if (rect.width > .5 && rect.height > .5) { left = Math.min(left, rect.left); right = Math.max(right, rect.right) } }
  const range = page.createRange(), walker = page.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let node: Node | null = body; node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) { if (/\S/.test(node.nodeValue ?? '')) { range.selectNodeContents(node); for (const rect of range.getClientRects()) take(rect) } continue }
    const element = node as Element, style = view.getComputedStyle(element)
    const under = (element.parentElement && behind.get(element.parentElement)) ?? base, fill = style.backgroundColor
    behind.set(element, clear(fill) ? under : fill)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    if (REPLACED.test(element.tagName)) { take(element.getBoundingClientRect()); continue }
    const border = (['Top', 'Right', 'Bottom', 'Left'] as const).some(side => parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== 'none' && !clear(style[`border${side}Color`]))
    if (border || style.backgroundImage !== 'none' || style.boxShadow !== 'none' || (!clear(fill) && fill !== under)) {
      const rect = element.getBoundingClientRect()
      if (rect.left > 1 || rect.right < width - 1) take(rect)
    }
  }
  if (!(left < right)) return [0, width]
  let from = Math.max(0, Math.floor(left) - MARGIN), to = Math.min(width, Math.ceil(right) + MARGIN)
  if (to - from < MIN_SPAN) { from = Math.max(0, Math.round((from + to - MIN_SPAN) / 2)); to = Math.min(width, from + MIN_SPAN); from = Math.max(0, to - MIN_SPAN) }
  return to - from >= width - 2 * MARGIN ? [0, width] : [from, to]
}

const sizes = new Map<string, FrameSize>(), started = new Set<string>(), listeners = new Set<() => void>()
let version = 0
const changed = () => { version++; for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
// Documents are keyed by a hash, so the cache holds no copies of them (an original carries its fonts as data: URLs).
const hashes = new Map<string, string>()
function hash(text: string) {
  let a = 0xdeadbeef, b = 0x41c6ce57
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677) }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909)
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909)
  return `${(b >>> 0).toString(36)}${(a >>> 0).toString(36)}${text.length.toString(36)}`
}
/** A document's key at a width, the same for the same document. */
export function frameKey(doc: string, width: number) {
  let key = hashes.get(doc)
  if (key === undefined) {
    key = hash(doc)
    if (hashes.size >= 32) hashes.delete(hashes.keys().next().value!)
    hashes.set(doc, key)
  }
  return `${width}:${key}`
}

function measure(doc: string, width: number, key: string) {
  if (started.has(key)) return
  started.add(key)
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-same-origin')
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  frame.inert = true
  // One pixel tall: what fills the window (height: 100%, 100vh) takes its content's height, as it does at that height.
  frame.style.cssText = `position:fixed;top:0;left:${-2 * MAX_WIDTH}px;width:${width}px;height:1px;border:0;visibility:hidden;pointer-events:none;color-scheme:normal`
  let done = false
  const loaded = () => frame.contentWindow?.location.href === 'about:srcdoc'
  const keep = (size: FrameSize) => {
    sizes.set(key, size)
    if (sizes.size > 400) { const oldest = sizes.keys().next().value!; sizes.delete(oldest); started.delete(oldest) }
    changed()
  }
  const read = (final: boolean) => {
    if (done) return
    const page = loaded() ? frame.contentDocument : null, root = page?.documentElement
    if (page && root) {
      let at = width
      const wide = Math.ceil(root.scrollWidth)
      if (wide > width + 1) { at = Math.min(wide, MAX_WIDTH); frame.style.width = `${at}px` }
      const [left, right] = span(page, at)
      keep({ width: at, height: Math.max(1, Math.ceil(root.scrollHeight)), left, right })
    } else if (final) keep({ width, height: 480, left: 0, right: width })
    if (final) { done = true; window.clearTimeout(slow); window.clearTimeout(giveUp); frame.remove() }
  }
  frame.addEventListener('load', () => {
    if (!loaded()) return
    const fonts = frame.contentDocument?.fonts.ready ?? Promise.resolve()
    void Promise.race([fonts, new Promise(resolve => window.setTimeout(resolve, 1000))]).then(() => read(true))
  })
  const slow = window.setTimeout(() => read(false), SLOW_MS), giveUp = window.setTimeout(() => read(true), GIVE_UP_MS)
  frame.srcdoc = doc
  document.body.append(frame)
}

/** A document's size at a width, if it has been measured (read while subscribed through useFrameSizes). */
export const frameSize = (doc: string, width: number) => sizes.get(frameKey(doc, width))

/** Each document's size at its width once it has loaded off screen (undefined until then); null documents wait. */
export function useFrameSizes(requests: readonly { doc: string | null; width: number }[]): (FrameSize | undefined)[] {
  useSyncExternalStore(subscribe, () => version)
  const keys = requests.map(({ doc, width }) => doc === null ? null : frameKey(doc, width))
  const wanted = keys.filter(Boolean).join(' ')
  useEffect(() => {
    requests.forEach(({ doc, width }, index) => { const key = keys[index]; if (doc !== null && key && !sizes.has(key)) measure(doc, width, key) })
  }, [wanted]) // eslint-disable-line react-hooks/exhaustive-deps
  return keys.map(key => key ? sizes.get(key) : undefined)
}

type Layer = { id: number; doc: string; size: FrameSize; loaded: boolean }
let layerIds = 0
/**
 * A document in a box `scale` times its shown span, cropped to it. A new document (another client, the other theme)
 * loads over the last one, which stays until it has, then fades in; the box eases to its size.
 */
export function EmailFrame({ doc, size, scale, title, pending = false }: { doc: string; size: FrameSize; scale: number; title: string; pending?: boolean }) {
  const [layers, setLayers] = useState<Layer[]>(() => [{ id: ++layerIds, doc, size, loaded: false }])
  const top = layers[layers.length - 1]
  if (top.doc !== doc) setLayers([...layers.filter(layer => layer.loaded).slice(-1), { id: ++layerIds, doc, size, loaded: false }])
  else if (top.size !== size) setLayers(layers.map(layer => layer === top ? { ...layer, size } : layer))
  const loaded = (id: number) => setLayers(list => { const index = list.findIndex(layer => layer.id === id); return index < 0 ? list : [{ ...list[index], loaded: true }, ...list.slice(index + 1)] })
  return <div className="email-frame" data-pending={pending || undefined} data-first={!layers.some(layer => layer.loaded) || undefined}
    style={{ width: Math.round(shownWidth(top.size) * scale), height: Math.round(top.size.height * scale) }}>
    {layers.map(layer => <iframe key={layer.id} title={title} srcDoc={layer.doc} sandbox="" referrerPolicy="no-referrer" data-loaded={layer.loaded || undefined} onLoad={() => loaded(layer.id)}
      style={{ width: layer.size.width, height: layer.size.height, transform: `translateX(${-layer.size.left * scale}px) scale(${scale})` }} />)}
  </div>
}
