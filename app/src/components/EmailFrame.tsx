import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'

// One sandboxed email frame for every view of an email (the original and each emulated client). The frame follows
// the preview contract: srcdoc in an iframe with sandbox="" (no scripts, an opaque origin) and a CSP that blocks
// remote loads (the original allows https images, minus tracking pixels: components/EmailPreview.tsx). An opaque
// frame can't report its height, so its layout is measured first in an inert, hidden copy at the frame's width
// (scripts never run; every URL is stripped), the box takes that height before the frame loads, and the frame fades in.
// The whole email shows; past MAX_HEIGHT it scrolls inside the frame, and the cut edge fades.
export const FRAME_WIDTH = { desktop: 800, mobile: 390 } as const
export type FrameDevice = keyof typeof FRAME_WIDTH
const MAX_HEIGHT = 1600
const GUARD = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer"><style>html{scrollbar-width:none}html::-webkit-scrollbar{display:none}</style>`
/** An emulated client's HTML (the API's previewEmail) as a frame document, with the guard first in its head. */
export const frameDocument = (html: string) => /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, head => head + GUARD) : GUARD + html
// Type selectors for the document's own root and body, renamed for the copy's stand-ins.
const ROOTS = /(^|[\s,>+~(}{])(:root|html|body)(?=[\s,.#:[>+~{)]|$)/gi
// Nothing in the copy may fetch: imports, image sets and url() go, in style sheets and style attributes alike.
const withoutUrls = (css: string) => css.replace(/@import[^;]*;?/gi, '').replace(/(?:-webkit-)?image-set\([^)]*\)/gi, 'none').replace(/url\([^)]*\)/gi, 'none')
export function measureHeight(html: string, width: number): number {
  const clean = DOMPurify.sanitize(html, { WHOLE_DOCUMENT: true, ADD_TAGS: ['style'], FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base', 'video', 'audio', 'source'], FORBID_ATTR: ['srcset', 'href', 'background', 'action', 'formaction', 'ping', 'xlink:href'] })
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  const css = withoutUrls([...doc.querySelectorAll('style')].map(style => { const text = style.textContent ?? ''; style.remove(); return text }).join('\n'))
    .replace(ROOTS, (_, before: string, root: string) => `${before}.ei-m-${root === 'body' ? 'body' : 'html'}`)
  // A blocked image keeps the frame's broken-image box; data: images (and a layout's placeholders) load in both.
  doc.querySelectorAll('[style]').forEach(element => element.setAttribute('style', withoutUrls(element.getAttribute('style') ?? '')))
  doc.querySelectorAll('[src]').forEach(element => { if (!/^data:image\//i.test(element.getAttribute('src') ?? '')) element.setAttribute('src', 'data:,') })
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = `position:absolute;top:0;left:-20000px;width:${width}px;visibility:hidden;pointer-events:none;contain:layout style paint`
  const root = host.attachShadow({ mode: 'closed' })
  const outer = document.createElement('div'), body = document.createElement('div')
  for (const { name, value } of doc.documentElement.attributes) outer.setAttribute(name, value)
  for (const { name, value } of doc.body.attributes) body.setAttribute(name, value)
  outer.classList.add('ei-m-html'); body.classList.add('ei-m-body')
  body.append(...doc.body.childNodes)
  outer.append(body)
  const style = document.createElement('style')
  // The browser's own body margin stands lowest, as the user agent's does in the frame, so the email's :where(body) wins.
  style.textContent = `:host{all:initial;display:block;width:${width}px}.ei-m-html{display:flow-root;width:${width}px}:where(.ei-m-body){display:block;margin:8px}\n${css}`
  root.append(style, outer)
  document.body.append(host)
  try { return Math.ceil(outer.getBoundingClientRect().height) } finally { host.remove() }
}

type Layer = { doc: string; width: number; height: number; loaded: boolean }
/** `doc` is what the frame shows (null while it is prepared: the box already holds its height), `layout` what it is measured from. */
export function EmailFrame({ doc, layout, device, title, pending = false }: { doc: string | null; layout: string; device: FrameDevice; title: string; pending?: boolean }) {
  const width = FRAME_WIDTH[device]
  const height = useMemo(() => Math.max(160, measureHeight(layout, width)), [layout, width])
  const box = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(0)
  useLayoutEffect(() => {
    const element = box.current!
    const read = () => setAvailable(element.clientWidth)
    read()
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // The previous frame stays until the next has loaded, then the next fades in over it.
  const [layers, setLayers] = useState<Layer[]>(() => doc ? [{ doc, width, height, loaded: false }] : [])
  const top = layers[layers.length - 1]
  if (doc && (top?.doc !== doc || top.width !== width)) setLayers([...layers.filter(layer => layer.loaded).slice(-1), { doc, width, height, loaded: false }])
  const loaded = (layer: Layer) => setLayers(list => { const index = list.indexOf(layer); return index < 0 ? list : [{ ...layer, loaded: true }, ...list.slice(index + 1)] })
  const scale = available ? Math.min(1, available / width) : 1
  const shown = Math.min(height, MAX_HEIGHT)
  return <div ref={box} className="email-frame" data-device={device} data-pending={pending || undefined} data-first={!layers.some(layer => layer.loaded) || undefined} data-more={height > MAX_HEIGHT || undefined} style={{ height: Math.ceil(shown * scale) }}>
    {layers.map(layer => <iframe key={`${layer.width}:${layer.doc}`} title={title} srcDoc={layer.doc} sandbox="" referrerPolicy="no-referrer" data-loaded={layer.loaded || undefined} onLoad={() => loaded(layer)}
      style={{ width: layer.width, height: Math.min(layer.height, MAX_HEIGHT), left: available ? Math.max(0, (available - layer.width * scale) / 2) : 0, transform: scale < 1 ? `scale(${scale})` : undefined }} />)}
  </div>
}
