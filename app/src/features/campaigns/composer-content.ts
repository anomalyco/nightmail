import type { QueryClient } from '@tanstack/react-query'
import { currentScope } from '../../data/live'
import { queries } from '../../data/queries'
import { ApiError, type Api, type Attachment, type AttachmentApi, type Campaign, type CampaignTemplate } from '../../data/types'
import { imageTags } from '../../lib/html-scan'
import { composer } from './composer-chunk'
import { MAX_ATTACHMENTS } from './copy'
import { isRasterDataUrl } from './block-content'

// What the composer saves: inlineAttachmentIds are the inline images the body uses, removedInlineIds the ones it no longer does.
export type ComposedDraft = { html: string; inlineAttachmentIds: string[]; removedInlineIds: string[] }
export const draftAttachments = (ids: string[] = [], draft: ComposedDraft) => [...new Set([...ids, ...draft.inlineAttachmentIds])].filter(id => !draft.removedInlineIds.includes(id))
// The API refused the content's blocks (api/src/campaign-blocks.ts). It judges tags and attributes, never text, so content
// with the same blockStructure would be refused again.
export const contentRefused = (cause: unknown) => cause instanceof ApiError && (cause.code === 'TEMPLATE_CONTENT_INVALID' || cause.code === 'CAMPAIGN_CONTENT_INVALID')
export const blockStructure = (html: string) => html.replace(/>[^<]*</g, '><')

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// A GIF keeps its animation: it goes up unchanged, within the 8 MiB an inline image may hold (a template asset's JSON
// upload). Other images are redrawn at most 1,200 px wide, so their source may be large: up to 40 MB and about
// 50 megapixels, measured before the image is decoded (50 MP decodes to 200 MB of pixels).
const MAX_GIF_BYTES = 8 * 1024 * 1024, MAX_SOURCE_BYTES = 40 * 1024 * 1024, MAX_SOURCE_PIXELS = 50_000_000
// Every recipient's message carries its inline images, so a redrawn image has a budget, as its data URL's length:
// 140,000 characters (about 105 KB) for a JPEG, reached by lowering quality, then size. An image with see-through
// pixels stays a PNG, the one format with transparency that every mail client shows. PNG has no quality to lower and
// costs several times a JPEG's bytes, so it gets 400,000 characters (about 300 KB), reached by size alone, and is
// never drawn under 600 px on its longer side (the email's column at 1x) unless the source is smaller: below that it
// would look soft at full width, so the editor says it doesn't fit instead.
const MAX_JPEG_URL = 140_000, MAX_PNG_URL = 400_000, MIN_PNG_SIDE = 600
// A pixel is see-through below this alpha (of 255): the 251 to 254 some exporters leave on an opaque image change no
// colour anyone can see when flattened.
const OPAQUE_ALPHA = 250
const unreadable = 'Couldn’t open this image. Export it as a PNG or JPEG and try again.'
const tooManyPixels = 'Choose an image under 50 megapixels.'
const tooLarge = 'This image is still too large for email. Choose a smaller image.'
const tooLargeTransparent = 'This image is too large to send with a transparent background. Choose a smaller image, or one with a solid background.'
function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error(unreadable))
    reader.onerror = () => reject(new Error(unreadable))
    reader.readAsDataURL(blob)
  })
}
// An image's size from its header: the browser reads it on load and decodes the pixels only when they are drawn.
async function imagePixels(file: File): Promise<number> {
  const url = URL.createObjectURL(file), image = new Image()
  try {
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error(unreadable)); image.src = url })
    return image.naturalWidth * image.naturalHeight
  } finally { URL.revokeObjectURL(url) }
}

export async function prepareLocalImage(file: File): Promise<{ url: string }> {
  const supported = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
  if (!supported.has(file.type)) throw new Error('Choose a PNG, JPEG, GIF, WebP, or AVIF image.')
  if (!file.size) throw new Error('This image is empty. Choose another image.')
  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer())
  const ascii = (start: number, end: number) => String.fromCharCode(...header.slice(start, end))
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') {
    if (file.size > MAX_GIF_BYTES) throw new Error('Choose a GIF smaller than 8 MiB.')
    // The logical screen's width and height follow the signature, little-endian.
    const width = header[6] | header[7] << 8, height = header[8] | header[9] << 8
    if (!width || !height) throw new Error(unreadable)
    if (width * height > MAX_SOURCE_PIXELS) throw new Error(tooManyPixels)
    return { url: await dataUrl(new Blob([file], { type: 'image/gif' })) }
  }
  if (file.size > MAX_SOURCE_BYTES) throw new Error('Choose an image smaller than 40 MiB.')
  if (typeof createImageBitmap !== 'function') throw new Error('This browser cannot optimize images. Try a current browser.')

  let bitmap: ImageBitmap
  const jpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
  try {
    const raster = (header[0] === 0x89 && ascii(1, 4) === 'PNG' && header[4] === 13 && header[5] === 10 && header[6] === 26 && header[7] === 10)
      || jpeg
      || (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP')
      || (ascii(4, 8) === 'ftyp' && ascii(8, 12) === 'avif')
    if (!raster) throw new Error(unreadable)
    if (await imagePixels(file) > MAX_SOURCE_PIXELS) throw new Error(tooManyPixels)
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch (cause) {
    throw new Error(cause instanceof Error && cause.message === tooManyPixels ? tooManyPixels : unreadable)
  }

  const canvas = document.createElement('canvas')
  let transparent = false
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('invalid dimensions')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas unavailable')
    let scale = Math.min(1, 1200 / bitmap.width, 1200 / bitmap.height)
    // Sizing the canvas clears it to transparent; a JPEG's paper is white.
    const draw = (paper: boolean) => {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      if (paper) { context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height) }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    }
    // Transparency is read from the pixels as they will be sent, not from the format: a PNG, WebP or AVIF whose
    // alpha channel is opaque throughout is a JPEG like any photo. A JPEG has no alpha to read.
    if (!jpeg) {
      draw(false)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      for (let alpha = 3; alpha < pixels.length; alpha += 4) if (pixels[alpha] < OPAQUE_ALPHA) { transparent = true; break }
    }
    if (transparent) {
      const smallest = Math.min(scale, MIN_PNG_SIDE / Math.max(bitmap.width, bitmap.height))
      for (;;) {
        const url = canvas.toDataURL('image/png')
        if (url.startsWith('data:image/png;base64,') && url.length <= MAX_PNG_URL) return { url }
        if (scale <= smallest) break
        // A PNG's bytes follow its pixel count: aim just under the budget, a tenth smaller at least.
        scale = Math.max(smallest, scale * Math.min(0.9, 0.97 * Math.sqrt(MAX_PNG_URL / url.length)))
        draw(false)
      }
    } else {
      for (let attempt = 0; attempt < 8; attempt++) {
        draw(true)
        for (const quality of [0.84, 0.68, 0.52, 0.36]) {
          const url = canvas.toDataURL('image/jpeg', quality)
          if (url.startsWith('data:image/jpeg;base64,') && url.length <= MAX_JPEG_URL) return { url }
        }
        scale *= 0.72
      }
    }
  } catch {
    throw new Error('Couldn’t optimize this image. Try a smaller PNG or JPEG image.')
  } finally {
    bitmap.close()
    canvas.width = 0
    canvas.height = 0
  }
  throw new Error(transparent ? tooLargeTransparent : tooLarge)
}

export function inlineImageSources(document: Record<string, unknown>): string[] {
  const sources = new Set<string>()
  const pending: unknown[] = [document]
  let count = 0
  while (pending.length && count++ < 20000) {
    const value = pending.pop()
    if (!isRecord(value)) continue
    if (value.type === 'image' && isRecord(value.attrs) && typeof value.attrs.src === 'string' && isRasterDataUrl(value.attrs.src)) sources.add(value.attrs.src)
    if (Array.isArray(value.content)) pending.push(...value.content)
  }
  return [...sources]
}
export async function inlineImageHash(source: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
export function replaceEditorImageSources(document: Record<string, unknown>, sources: ReadonlyMap<string, string>): Record<string, unknown> {
  const copy = structuredClone(document)
  const pending: unknown[] = [copy]
  let count = 0
  while (pending.length && count++ < 20000) {
    const value = pending.pop()
    if (!isRecord(value)) continue
    if (value.type === 'image' && isRecord(value.attrs) && typeof value.attrs.src === 'string') {
      const replacement = sources.get(value.attrs.src)
      if (replacement) value.attrs.src = replacement
    }
    if (Array.isArray(value.content)) pending.push(...value.content)
  }
  return copy
}
export function cidImageSources(html: string): Set<string> {
  const ids = new Set<string>()
  for (const tag of imageTags(html)) {
    const match = /\ssrc\s*=\s*(["'])cid:([a-zA-Z0-9_.@-]{1,120})\1/i.exec(tag)
    if (match) ids.add(match[2])
  }
  return ids
}
const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const isRasterType = (type: string) => rasterTypes.has(type.toLowerCase())
function rasterBytesMatch(bytes: Uint8Array, type: string): boolean {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end))
  if (type === 'image/png') return bytes[0] === 0x89 && ascii(1, 4) === 'PNG' && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (type === 'image/gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6))
  if (type === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
  return type === 'image/avif' && ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))
}
export type AttachmentKind = 'campaigns' | 'templates'
export const attachmentKind = (api: Api, provided?: AttachmentApi): AttachmentKind =>
  provided && provided === api.templateAssets ? 'templates' : 'campaigns'
export const attachmentMetaKey = (kind: AttachmentKind, id: string) => ['nightmail', 'attachment', kind, id] as const
export const attachmentContentKey = (kind: AttachmentKind, id: string) => ['nightmail', 'attachment-content', kind, id] as const

// Attachments are immutable content-addressed blobs within a workspace. Cache validated inline data URLs
// synchronously per request-scope epoch (cleared immediately on workspace/account switch) so reopening a
// campaign or template renders inline images on the first frame with zero network round trips.
const MAX_CACHED_INLINE = 64
type CachedInline = { item: Attachment; url: string }
const inlineCache = new Map<string, CachedInline>()
let inlineCacheEpoch = -1
function ensureInlineCacheScope() {
  const epoch = currentScope().epoch
  if (epoch !== inlineCacheEpoch) {
    inlineCache.clear()
    inlineCacheEpoch = epoch
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('nightmail:scope-changed', () => {
    inlineCache.clear()
    inlineCacheEpoch = currentScope().epoch
  })
}
const inlineCacheKey = (kind: AttachmentKind, id: string) => `${kind}:${id}`
export function rememberInlineAttachment(kind: AttachmentKind, item: Attachment, url: string, cache?: QueryClient) {
  ensureInlineCacheScope()
  const key = inlineCacheKey(kind, item.id)
  if (inlineCache.has(key)) inlineCache.delete(key)
  else if (inlineCache.size >= MAX_CACHED_INLINE) {
    const oldest = inlineCache.keys().next().value
    if (oldest !== undefined) inlineCache.delete(oldest)
  }
  inlineCache.set(key, { item, url })
  if (cache) cache.setQueryData(attachmentMetaKey(kind, item.id), item)
}
export function cachedInlineAttachments(kind: AttachmentKind, attachmentIds: readonly string[], needed: ReadonlySet<string>): {
  sources: Map<string, string>
  items: Map<string, Attachment>
  missing: Set<string>
} {
  ensureInlineCacheScope()
  const sources = new Map<string, string>(), items = new Map<string, Attachment>(), missing = new Set(needed)
  if (!needed.size || !attachmentIds.length) return { sources, items, missing }
  for (const id of new Set(attachmentIds)) {
    const entry = inlineCache.get(inlineCacheKey(kind, id))
    if (!entry) continue
    const { item, url } = entry
    if (item.disposition === 'inline' && item.contentId && missing.has(item.contentId)) {
      sources.set(`cid:${item.contentId}`, url)
      items.set(url, item)
      missing.delete(item.contentId)
    }
  }
  return { sources, items, missing }
}

/** Deterministic flat placeholder SVG reserving exact image dimensions while an uncached cid: image loads.
 *  Uses image/svg+xml so isRasterDataUrl() and safeImageSource() never mistake it for a saved raster image. */
export function pendingCidPlaceholder(cid: string, width?: unknown, height?: unknown): string {
  const parsePx = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.min(2000, Math.round(value))
    if (typeof value === 'string' && /^[1-9][0-9]{0,3}$/.test(value.trim())) return Math.min(2000, Number(value.trim()))
    return null
  }
  const w = parsePx(width) ?? 360
  const h = parsePx(height) ?? 160
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" data-pending-cid="${encodeURIComponent(cid)}"><rect width="100%" height="100%" rx="4" fill="#EDEDED"/></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export function fetchAttachmentMetadata(cache: QueryClient | undefined, attachments: AttachmentApi, kind: AttachmentKind, id: string, signal?: AbortSignal): Promise<Attachment> {
  if (!cache) return attachments.get(id, signal)
  return cache.fetchQuery({
    queryKey: attachmentMetaKey(kind, id),
    queryFn: ({ signal: querySignal }) => attachments.get(id, querySignal),
    staleTime: Infinity,
  })
}
export function fetchAttachmentContent(cache: QueryClient | undefined, attachments: AttachmentApi, kind: AttachmentKind, id: string, signal?: AbortSignal) {
  if (!cache) return attachments.content(id, signal)
  return cache.fetchQuery({
    queryKey: attachmentContentKey(kind, id),
    queryFn: ({ signal: querySignal }) => attachments.content(id, querySignal),
    staleTime: Infinity,
  })
}

export async function loadInlineAttachments(
  attachments: AttachmentApi,
  attachmentIds: string[],
  needed: ReadonlySet<string>,
  signal: AbortSignal,
  options?: { cache?: QueryClient; kind?: AttachmentKind },
): Promise<{sources: Map<string, string>; items: Map<string, Attachment>}> {
  const kind = options?.kind
  const cache = options?.cache
  const sources = new Map<string, string>(), items = new Map<string, Attachment>()
  if (!needed.size) return {sources, items}
  const ids = [...new Set(attachmentIds)]
  if (ids.length > MAX_ATTACHMENTS) throw new Error('Too many attachments to preview.')
  const remaining = new Set(needed)
  if (kind) {
    const hit = cachedInlineAttachments(kind, ids, needed)
    hit.sources.forEach((url, cid) => sources.set(cid, url))
    hit.items.forEach((item, url) => items.set(url, item))
    if (!hit.missing.size) return { sources, items }
    remaining.clear()
    hit.missing.forEach(cid => remaining.add(cid))
  }
  const metadata = await Promise.all(ids.map(id =>
    kind && cache ? fetchAttachmentMetadata(cache, attachments, kind, id, signal) : attachments.get(id, signal),
  ))
  if (signal.aborted) throw new DOMException('Preview canceled.', 'AbortError')
  const inline = metadata.filter(item => item.disposition === 'inline' && item.contentId && remaining.has(item.contentId) && rasterTypes.has(item.contentType.toLowerCase()))
  const allInlineBytes = metadata
    .filter(item => item.disposition === 'inline' && item.contentId && needed.has(item.contentId) && rasterTypes.has(item.contentType.toLowerCase()))
    .reduce((total, item) => total + item.size, 0)
  if (allInlineBytes > 8 * 1024 * 1024) throw new Error('Inline images exceed the 8 MiB preview limit.')
  const results = await Promise.allSettled(inline.map(async item => {
    const result = kind && cache
      ? await fetchAttachmentContent(cache, attachments, kind, item.id, signal)
      : await attachments.content(item.id, signal)
    const type = result.contentType.toLowerCase()
    if (result.id !== item.id || type !== item.contentType.toLowerCase() || !rasterTypes.has(type) || result.content.length > 11184812) throw new Error('Attachment preview metadata does not match.')
    // A repeated four-character regex group over 8 MiB can exhaust the JavaScript engine's stack.
    if (result.content.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.content)) throw new Error('Attachment preview encoding is invalid.')
    const bytes = Uint8Array.from(atob(result.content), character => character.charCodeAt(0))
    if (bytes.length !== item.size || !rasterBytesMatch(bytes, type)) throw new Error('The attachment is not a supported raster image.')
    if (signal.aborted) throw new DOMException('Preview canceled.', 'AbortError')
    const url = `data:${type};base64,${result.content}`
    if (kind) rememberInlineAttachment(kind, item, url, cache)
    sources.set(`cid:${item.contentId}`, url)
    items.set(url, item)
  }))
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  return {sources, items}
}

const WARM_FRESH = 30_000
/** Preloads the composer chunk, campaign detail, verified domains, and any inline cid: images before the click lands. */
export async function warmCampaignEditor(cache: QueryClient, api: Api, id: string): Promise<void> {
  void composer.preload().catch(() => {})
  const campaignQuery = queries.campaign(id)
  const domainsPromise = cache.prefetchQuery({
    queryKey: ['nightmail', 'campaign-options', { pageSize: 100, domains: undefined }],
    queryFn: async ({ signal }) => {
      const domainPage = await api.domains.list({ pageSize: 100, cursor: undefined, refresh: false }, signal)
      return { domains: domainPage.items.filter(domain => domain.status === 'verified' && !domain.builtIn), next: domainPage.nextCursor }
    },
    staleTime: WARM_FRESH,
  }).catch(() => {})
  const campaign = await cache.fetchQuery<Campaign>({
    queryKey: ['nightmail', ...campaignQuery.key],
    queryFn: ({ signal }) => campaignQuery.read(api, signal),
    staleTime: WARM_FRESH,
  }).catch(() => null)
  if (campaign?.attachments?.length) {
    const needed = cidImageSources(campaign.html)
    if (needed.size) {
      const controller = new AbortController()
      await loadInlineAttachments(api.attachments, campaign.attachments, needed, controller.signal, { cache, kind: 'campaigns' }).catch(() => {})
    } else {
      await Promise.allSettled(campaign.attachments.map(attId => fetchAttachmentMetadata(cache, api.attachments, 'campaigns', attId)))
    }
  }
  await domainsPromise
}

/** Preloads the composer chunk, template detail, and any inline cid: assets before the click lands. */
export async function warmTemplateEditor(cache: QueryClient, api: Api, id: string): Promise<void> {
  void composer.preload().catch(() => {})
  const templateQuery = queries.template(id)
  const template = await cache.fetchQuery<CampaignTemplate>({
    queryKey: ['nightmail', ...templateQuery.key],
    queryFn: ({ signal }) => templateQuery.read(api, signal),
    staleTime: WARM_FRESH,
  }).catch(() => null)
  if (template?.draft.attachments?.length) {
    const needed = cidImageSources(template.draft.html ?? '')
    if (needed.size) {
      const controller = new AbortController()
      await loadInlineAttachments(api.templateAssets, template.draft.attachments, needed, controller.signal, { cache, kind: 'templates' }).catch(() => {})
    }
  }
}

/** Schedules a non-urgent preload once the browser has painted and gone idle. Returns a cancel function. */
export function onIdle(run: () => void, timeout = 250): () => void {
  if (typeof window === 'undefined') return () => {}
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(() => run(), { timeout })
    return () => window.cancelIdleCallback(handle)
  }
  const handle = window.setTimeout(run, 60)
  return () => window.clearTimeout(handle)
}
