import type { RenderedImage } from '../core/types.js';

const WIDTH = 720;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const tooLarge = () => new Error('Rendered campaign preview exceeds the image size limit.');
/** `grow(bytes)` is told how much the screenshot will hold before each allocation; it throws to stop the read. */
export function browserImageRenderer(binding: BrowserRun) {
  return async (html: string, grow?: (bytes: number) => void): Promise<RenderedImage> => {
    const response = await binding.quickAction('screenshot', {
      // No scrollPage: it only drives JS scroll/lazy-load handlers, and with JS disabled Browser Run now
      // hangs on it until actionTimeout. captureBeyondViewport already captures the full email.
      // Browser Run retries a timed-out action once, so 10 s bounds a failure at ~21 s.
      html, viewport: { width: WIDTH, height: 900, deviceScaleFactor: 1 }, selector: 'body > table',
      setJavaScriptEnabled: false, cacheTTL: 0, actionTimeout: 10_000,
      screenshotOptions: { type: 'png', encoding: 'binary', captureBeyondViewport: true },
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Browser Rendering returned HTTP ${response.status}.`); }
    // Read at most MAX_IMAGE_BYTES. With a Content-Length, charge it and read into one buffer; without one, charge the
    // chunks and their joined copy as they arrive.
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (declared > MAX_IMAGE_BYTES) { await response.body?.cancel(); throw tooLarge(); }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
    const buffer = Number.isSafeInteger(declared) && declared > 0 ? (grow?.(declared), new Uint8Array(declared)) : undefined;
    let size = 0;
    try {
      for (let read = await reader?.read(); read && !read.done; read = await reader!.read()) {
        size += read.value.byteLength;
        if (size > (buffer?.byteLength ?? MAX_IMAGE_BYTES)) throw tooLarge();
        if (buffer) buffer.set(read.value, size - read.value.byteLength);
        else { grow?.(2 * size); chunks.push(read.value); }
      }
    } catch (error) { await reader?.cancel().catch(() => undefined); throw error; }
    if (!size || (buffer && size !== buffer.byteLength)) throw new Error('Browser Rendering returned an incomplete screenshot.');
    let data = buffer ?? chunks[0]!;
    if (!buffer && chunks.length > 1) { data = new Uint8Array(size); let at = 0; for (const chunk of chunks.splice(0)) { data.set(chunk, at); at += chunk.byteLength; } }
    return { data, mimeType: 'image/png' };
  };
}
