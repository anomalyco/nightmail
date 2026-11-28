import { Buffer } from 'node:buffer';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { z } from '@hono/zod-openapi';
import { ApiError, id, type App, type Ctx, type RenderedImage, type Runtime } from './core.js';

// Visual previews embed every cid: reference as the image's whole data URI and hold the page while Browser Run renders
// it. Everything a preview holds is counted against one budget per isolate (a Worker isolate has 128 MB; on Node, per
// process), from before the first read until its result is stored: the handler releases it before it responds, and the
// result is served from storage through a five-minute link, so no response body holds preview bytes in this process.
const MiB = 1024 * 1024;
export const PREVIEW_MEMORY_BUDGET = 24 * MiB;
// One preview's page, counted as it is held: the largest raw image (read and encoded one at a time), then three copies
// of the page with its data URIs (built, serialized for the renderer, and that request's body). Two fit the budget.
export const PREVIEW_INLINE_LIMIT = 8 * MiB;
// Held for the screenshot from the start. A larger one grows the share as Browser Run's response is read; the stored
// JSON is then built in one buffer next to the PNG.
const SCREENSHOT_RESERVE = 2 * MiB, CHUNK = 48 * 1024;
let held = 0;

const busy = () => new ApiError(429, 'PREVIEW_BUSY', 'This server is rendering other previews. Retry in a few seconds.', undefined, true, new Date(Date.now() + 5000).toISOString());
function reserve(bytes: number) {
  if (held + bytes > PREVIEW_MEMORY_BUDGET) throw busy();
  held += bytes;
  let own = bytes;
  return {
    resize(next: number) { if (next > own && held - own + next > PREVIEW_MEMORY_BUDGET) throw busy(); held += next - own; own = next; },
    release() { held -= own; own = 0; },
  };
}

// ---------- links ----------

export const PreviewImageLink = z.object({
  url: z.string().url().describe('Serves the 200 response (the base64 PNG as JSON) without a credential until expiresAt.'),
  expiresAt: z.string().datetime(), mimeType: z.literal('image/png'),
}).openapi('PreviewImageLink');
// The two preview routes answer 303 to the stored preview; a client that follows it receives what they used to return.
export const PREVIEW_ROUTE_NOTE = ' Answers 303 See Other: Location (also url in the body) serves the result as JSON { data, mimeType } for five minutes without a credential, so HTTP clients that follow redirects receive it as before. Inline images may total about 1.5 MiB, counted once per reference (413 PREVIEW_TOO_LARGE above); while the server renders other previews it answers 429 PREVIEW_BUSY with Retry-After. HEAD is refused with 405: it would render a preview it cannot return.';
export const previewResponses = <T extends z.ZodType>(schema: T) => ({
  200: { description: 'What the 303 link serves.', content: { 'application/json': { schema } } },
  303: { description: 'The preview is stored: follow Location within five minutes.', headers: z.object({ Location: z.string().url() }), content: { 'application/json': { schema: PreviewImageLink } } },
});
export function refuseHead(c: Ctx) {
  if (c.req.method !== 'HEAD') return;
  c.header('Allow', 'GET');
  throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET: a HEAD request would render a preview it cannot return.');
}
const LINK_SECONDS = 300, PREFIX = 'previews/', KEY = /^previews\/([^/]+)\/preview_[0-9a-f]{32}\.json$/;
const linkKeys = new Map<string, Buffer>();
const linkTag = (secret: string, data: string) => {
  const key = linkKeys.get(secret) ?? Buffer.from(hkdfSync('sha256', secret, '', 'bane:preview-image:v1', 32));
  linkKeys.set(secret, key);
  return createHmac('sha256', key).update(data).digest('base64url');
};
/** A link to a stored preview that works without a credential for five minutes, for that workspace's object only. */
export function previewLink(runtime: Pick<Runtime, 'config'>, workspaceId: string, key: string, now = Date.now()) {
  const e = Math.floor(now / 1000) + LINK_SECONDS, data = Buffer.from(JSON.stringify({ w: workspaceId, k: key, e })).toString('base64url');
  return { url: `${runtime.config.publicUrl}/v1/preview-images/${data}.${linkTag(runtime.config.authSecret, data)}`, expiresAt: new Date(e * 1000).toISOString() };
}
export function registerPreviewImages(app: App) {
  // The token is the credential, so the API gate lets this route through (app.ts).
  app.get('/v1/preview-images/:token', async c => {
    const missing = () => new ApiError(404, 'NOT_FOUND', 'This preview link is invalid or has expired.'), token = c.req.param('token');
    if (token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw missing();
    const [data, mac] = token.split('.') as [string, string];
    const secrets = [c.env.config.authSecret, c.env.config.previousAuthSecret].filter((s): s is string => !!s);
    if (!secrets.some(secret => timingSafeEqual(Buffer.from(mac), Buffer.from(linkTag(secret, data))))) throw missing();
    let claims: { w?: unknown; k?: unknown; e?: unknown };
    try { claims = JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { throw missing(); }
    if (!Number.isSafeInteger(claims.e) || (claims.e as number) <= Date.now() / 1000 || typeof claims.w !== 'string' || typeof claims.k !== 'string' || KEY.exec(claims.k)?.[1] !== claims.w) throw missing();
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Content-Type-Options': 'nosniff' };
    if (c.req.method === 'HEAD') return new Response(null, { headers });
    // Streamed from the bucket where the storage can, so a slow reader holds nothing here.
    if (c.env.storage.stream) {
      const object = await c.env.storage.stream(claims.k);
      if (!object) throw missing();
      return new Response(object.body, { headers });
    }
    const object = await c.env.storage.get(claims.k);
    if (!object) throw missing();
    return new Response(new Blob([object.body as Uint8Array<ArrayBuffer>]), { headers });
  });
}
/** Hourly: stored previews are read through five-minute links; delete those older than ten minutes. */
export async function sweepPreviews(runtime: Pick<Runtime, 'storage'>, budgetMs = 60_000, now = Date.now()) {
  if (!runtime.storage.list) return 0;
  const deadline = Date.now() + budgetMs, old = now - 2 * LINK_SECONDS * 1000;
  let deleted = 0, after: string | undefined;
  do {
    const page = await runtime.storage.list(PREFIX, after);
    for (const object of page.objects) if (KEY.test(object.key) && object.uploaded.getTime() <= old && Date.now() < deadline) { await runtime.storage.delete(object.key); deleted++; }
    after = page.cursor;
  } while (after && Date.now() < deadline);
  return deleted;
}

// ---------- rendering ----------

type InlineImage = { contentId: string | null; contentType: string; size: number };
/** The data: URI's media type: the image's bare type/subtype, without the parameters stored with it. Anything else is octet-stream. */
export const dataUriType = (contentType: string) => { const bare = contentType.split(';')[0]!.trim().toLowerCase(); return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(bare) ? bare : 'application/octet-stream'; };
/**
 * Renders a preview page with its inline images embedded, stores `{ data, mimeType, ...fields }` as JSON and returns a
 * link to it. Work that does not fit this isolate's budget is refused before any image is read; the budget is released
 * before this returns, whatever happens.
 */
export async function renderPreview<T extends InlineImage>(runtime: Pick<Runtime, 'allowPreview' | 'storage' | 'config'>, workspaceId: string, html: string, items: T[],
  read: (item: T) => Promise<Uint8Array>, render: (html: string, grow: (bytes: number) => void) => Promise<RenderedImage>, fields: Record<string, unknown> = {}) {
  const byReference = new Map<string, T>();
  for (const item of items) if (item.contentId && !byReference.has(`cid:${item.contentId}`)) byReference.set(`cid:${item.contentId}`, item);
  // One pass, longest reference first: an embedded URI is never scanned again (a content type may contain "cid:"),
  // and cid:logo never replaces the start of cid:logo2.
  const pattern = new RegExp([...byReference.keys()].sort((a, b) => b.length - a.length).map(reference => reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '(?!)', 'g');
  const counts = new Map<string, number>();
  for (const [reference] of html.matchAll(pattern)) counts.set(reference, (counts.get(reference) ?? 0) + 1);
  let encoded = 0, largest = 0;
  for (const [reference, count] of counts) {
    const item = byReference.get(reference)!;
    encoded += count * (`data:${dataUriType(item.contentType)};base64,`.length + 4 * Math.ceil(item.size / 3)); largest = Math.max(largest, item.size);
  }
  // A page with any character beyond Latin-1 is a two-byte string in V8, data URIs included.
  const page = largest + 3 * (/[^\x00-\xff]/.test(html) ? 2 : 1) * (html.length + encoded);
  if (page > PREVIEW_INLINE_LIMIT) throw new ApiError(413, 'PREVIEW_TOO_LARGE', `Previewing these inline images needs ${(page / MiB).toFixed(1)} MiB; the limit is ${PREVIEW_INLINE_LIMIT / MiB} MiB. Use smaller images or reference each one once.`);
  if (runtime.allowPreview && !await runtime.allowPreview(workspaceId, page + SCREENSHOT_RESERVE))
    throw new ApiError(429, 'RENDER_RATE_LIMITED', 'This workspace previewed too many large pages this minute. Retry after the window resets.', undefined, true, new Date(Date.now() + 60_000).toISOString());
  const memory = reserve(page + SCREENSHOT_RESERVE);
  try {
    if (counts.size) {
      const uris = new Map<string, string>();
      for (const reference of counts.keys()) {
        const item = byReference.get(reference)!, body = await read(item);
        uris.set(reference, `data:${dataUriType(item.contentType)};base64,${Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('base64')}`);
      }
      html = html.replace(pattern, reference => uris.get(reference)!);
    }
    const { data: png, mimeType } = await render(html, bytes => memory.resize(page + Math.max(SCREENSHOT_RESERVE, bytes)));
    html = '';
    // The page is gone. The stored JSON is written into one buffer next to the PNG, 64 KiB of base64 at a time.
    const encoder = new TextEncoder(), prefix = encoder.encode('{"data":"'), suffix = encoder.encode(`",${JSON.stringify({ mimeType, ...fields }).slice(1)}`);
    const length = prefix.length + 4 * Math.ceil(png.byteLength / 3) + suffix.length;
    memory.resize(png.byteLength + length);
    const json = new Uint8Array(length);
    json.set(prefix);
    let at = prefix.length;
    for (let offset = 0; offset < png.byteLength; offset += CHUNK) at += encoder.encodeInto(Buffer.from(png.buffer, png.byteOffset + offset, Math.min(CHUNK, png.byteLength - offset)).toString('base64'), json.subarray(at)).written;
    json.set(suffix, at);
    const key = `${PREFIX}${workspaceId}/${id('preview')}.json`;
    await runtime.storage.put(key, json, 'application/json');
    return previewLink(runtime, workspaceId, key);
  } finally { memory.release(); }
}
