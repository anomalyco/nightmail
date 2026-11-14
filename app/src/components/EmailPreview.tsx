import { useEffect, useMemo, useState } from 'react';
import type { AttachmentApi } from '../data/types';
import { useApi } from '../data/context';
import { cidImageSources, isRasterDataUrl, loadInlineAttachments } from '../features/campaigns/composer-content';
import { mentionsRemoteImage, withoutFontStyles } from '../lib/html-scan';
import DOMPurify from 'dompurify';
import { Alert, Button } from './ui';

export function htmlToText(html: string): string {
  const clean = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'script'] });
  const email = new DOMParser().parseFromString(clean, 'text/html');
  email.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  email.querySelectorAll('p, div, h1, h2, h3, h4, li, tr, blockquote').forEach(node => node.append('\n'));
  return (email.body.textContent ?? '').replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Known open-tracking endpoints (ESP pixels, SES open tracking) and generic pixel paths.
const TRACKING_URL = /(?:awstrack\.me|list-manage\.com\/track|\/wf\/open|sendgrid\.net\/wf|mandrillapp\.com\/track|pstmrk\.it|pmtrk|track\.customer\.io\/e\/o|mailgun\.[a-z]+\/o\/|emltrk\.com|sidekickopen|hubspotlinks|mixmax\.com\/api\/track|mailtrack\.io|getnotify\.com|bananatag|yesware)/i;
// Generic pixel paths only count when the URL is not an ordinary image file (e.g. /tracking-logo.png).
const TRACKING_PATH = /\/(?:track|tracking|open|opens|pixel|beacon)(?:[\/.?_-]|$)/i;
const IMAGE_FILE = /\.(?:png|jpe?g|svg|webp|avif)(?:[?#]|$)/i;
const px = (value: string | null | undefined) => { const match = value?.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i); return match ? Number(match[1]) : null; };
/** Tracking pixels: known tracker URLs, or remote images sized ≤2px (or zero in either dimension) or hidden by inline style. */
export function isTrackingPixel(image: Element): boolean {
  const source = image.getAttribute('src') ?? '';
  if (TRACKING_URL.test(source) || (TRACKING_PATH.test(source) && !IMAGE_FILE.test(source))) return true;
  const style = (image.getAttribute('style') ?? '').toLowerCase().replace(/\s+/g, '');
  const styleSize = (name: string) => px(style.match(new RegExp(`(?:^|;)${name}:([\\d.]+(?:px)?)`))?.[1]);
  const width = px(image.getAttribute('width')) ?? styleSize('width'), height = px(image.getAttribute('height')) ?? styleSize('height');
  if (width === 0 || height === 0 || (width !== null && height !== null && width <= 2 && height <= 2)) return true;
  return /(?:^|;)(?:display:none|visibility:hidden|opacity:0(?:;|$)|max-height:0)/.test(style);
}

/**
 * Received mail: remote images (and CSS backgrounds) stay blocked until the reader asks, so a
 * sender can't learn when, or from which address, a message was opened (L14).
 * tooComplex is the API's htmlTooComplex: markup past the API's parsing budget is not parsed here either, and the
 * message's text stays readable.
 */
export function ReceivedEmailPreview({ tooComplex, ...props }: Omit<EmailPreviewProps, 'remoteImages'> & { tooComplex?: boolean }) {
  return tooComplex ? <Alert tone="info">This message’s formatting is too complex to show. Read it as plain text.</Alert> : <ReceivedHtml {...props} />;
}
function ReceivedHtml(props: Omit<EmailPreviewProps, 'remoteImages'>) {
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const load = loadedFor === props.html;
  const remote = useMemo(() => mentionsRemoteImage(props.html), [props.html]);
  return <>{remote && !load && <Alert tone="info">Remote images are hidden so the sender can’t tell when you open this message. <Button variant="ghost" size="sm" onClick={() => setLoadedFor(props.html)}>Load images</Button></Alert>}<EmailPreview {...props} remoteImages={load} /></>;
}

// The sandboxed frame can't fetch, so it gets Inter as data: URLs, read once per file per session: the Latin files
// (the dashboard's own, app/src/styles/tokens.css), the other-scripts file only for email text that needs it, and the
// italic only for email that uses it. Sent mail itself links the full files.
const LATIN_RANGE = 'U+0000-017F, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0300-0304, U+0308, U+0329, U+2000-206F, U+20A0-20CF, U+2100-214F, U+2190-23FF, U+25A0-25FF, U+2713-2717, U+FEFF, U+FFFD';
const EXT_RANGE = 'U+0180-02BA, U+02BD-02C5, U+02C7-02D9, U+02DB, U+02DD-02FF, U+0306-0307, U+0309-0328, U+032C-052F, U+0E3F, U+1D00-1FFE, U+2070-209C, U+20DB-20F0, U+2150-2189, U+2423-2468, U+24B6-24EA, U+2600-26A0, U+2756-2788, U+27EF-27FA, U+2913, U+2A38, U+2B06-2B24, U+2C7C-2C7F, U+2DFF-2E18, U+A69F, U+A7FF, U+A92E, U+E000-E163, U+E1C3-E2DC, U+EE01-EEE1, U+F6C3, U+1F12F-1F16B, U+1F850-1F852';
const OTHER_SCRIPTS = /[\u0180-\u02BA\u0370-\u052F\u0E3F\u1D00-\u1FFE\u2070-\u209C\u2150-\u2189]/;
const ITALIC = /<(?:em|i|cite|var|dfn)\b|italic/i;
const fontData = new Map<string, Promise<string>>();
function fontSource(path: string) {
  let source = fontData.get(path);
  if (!source) {
    source = fetch(path).then(response => { if (!response.ok) throw new Error('Font unavailable'); return response.blob(); }).then(blob => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(new Blob([blob], { type: 'font/woff2' }));
    }));
    source.catch(() => fontData.delete(path));
    fontData.set(path, source);
  }
  return source;
}

/** inlineImages maps a received message's Content-IDs to its signed https attachment links. */
export type EmailPreviewProps = { html: string; title?: string; className?: string; attachmentIds?: string[]; attachmentApi?: AttachmentApi; respectStyles?: boolean; remoteImages?: boolean; inlineImages?: Record<string, string> };
type DocumentOptions = { respectStyles: boolean; remoteImages: boolean; inline: Map<string, URL> };

// A px length from an attribute (width="600") or the element's inline style (width: 600px).
const declared = (element: Element, name: 'width' | 'height') => px(element.getAttribute(name)) ?? px(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([\\d.]+)px`, 'i').exec(element.getAttribute('style') ?? '')?.[1]);
/** An image that loads later (a remote one, or an inline attachment still being read) holds its declared size, and is
 *  twice as wide as tall when only one side is declared: the room a layout measured before it loads leaves for it. An
 *  image that hasn't loaded has no shape of its own, so the size is also its aspect ratio. */
function holdSize(element: Element) {
  const width = declared(element, 'width'), height = declared(element, 'height');
  if (width === null && height === null) return false;
  const w = Math.round(width ?? height! * 2), h = Math.round(height ?? width! / 2);
  element.setAttribute('src', `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`)}`);
  element.setAttribute('style', `${element.getAttribute('style') ?? ''};aspect-ratio:${w}/${h}`);
  return true;
}

// The preview's document: sanitized, every URL dropped but the images it may show, a CSP that blocks everything else,
// and the frame's base styles. `layout` is the copy a frame measures its height from: placeholders for images that load
// later, and no font data (the dashboard's own Inter stands in).
function emailDocument(html: string, { respectStyles, remoteImages, inline }: DocumentOptions, sources: Map<string, string> | undefined, fontFaces: string, layout = false) {
  // Authenticated, validated raster data is assigned from the attachment map
  // after DOMPurify; the opaque sandbox never needs access to parent Blob URLs.
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    USE_PROFILES: { html: true },
    ADD_TAGS: ['style'],
    // DOMPurify's default URI rule: a custom ALLOWED_URI_REGEXP also strips ordinary values such as
    // width="1", which hid tracking pixels from isTrackingPixel. Image sources are checked below.
    FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'source', 'link', 'base', 'meta'],
    FORBID_ATTR: ['href', 'srcset', 'ping', 'action', 'formaction', 'target', 'download', 'autofocus', 'xlink:href', 'background'],
  });
  const email = new DOMParser().parseFromString(clean, 'text/html');
  email.querySelectorAll('style[data-bane-fonts], style[data-opensend-fonts]').forEach(style => style.remove());
  email.querySelectorAll('[src]').forEach(element => {
    const source = element.getAttribute('src') ?? '';
    const owned = element.tagName === 'IMG' ? sources?.get(source) ?? inline.get(source)?.href : undefined;
    const later = layout && element.tagName === 'IMG' && (/^cid:/i.test(source) || (remoteImages && /^https:\/\//i.test(source) && !isTrackingPixel(element)));
    if (later) { if (!holdSize(element)) element.removeAttribute('src'); }
    else if (owned) element.setAttribute('src', owned);
    else if (remoteImages && element.tagName === 'IMG' && /^https?:\/\//i.test(source) && isTrackingPixel(element)) element.remove();
    else if (element.tagName !== 'IMG' || !(isRasterDataUrl(source) || (remoteImages && /^https:\/\//i.test(source)))) element.removeAttribute('src');
  });
  const csp = email.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  const inlineOrigins = [...new Set([...inline.values()].map(url => url.origin))].join(' ');
  csp.content = `default-src 'none'; style-src 'unsafe-inline'; img-src data:${remoteImages ? ' https:' : inlineOrigins ? ` ${inlineOrigins}` : ''}; font-src data:; script-src 'none'; form-action 'none'; base-uri 'none'; connect-src 'none'`;
  email.head.prepend(csp);
  const referrer = email.createElement('meta');
  referrer.name = 'referrer';
  referrer.content = 'no-referrer';
  email.head.prepend(referrer);
  const tokens = getComputedStyle(document.documentElement);
  const style = email.createElement('style');
  // Reuse the browser's cached font files without opening network access inside the sandbox.
  style.textContent = `${fontFaces} :root { --font-email: ${tokens.getPropertyValue('--font-email')}; --tracking-email: ${tokens.getPropertyValue('--tracking-email')}; --color-text: ${tokens.getPropertyValue('--color-email-text')}; --color-surface: ${tokens.getPropertyValue('--color-email-surface')}; } :where(html) { color-scheme: light; background: var(--color-surface); color: var(--color-text); scrollbar-width: none; } ::-webkit-scrollbar { display: none; } :where(body) { margin: 24px; line-height: 1.5; overflow-wrap: anywhere; font-family: var(--font-email); letter-spacing: var(--tracking-email); } ${respectStyles ? '' : 'body, body * { font-family: var(--font-email) !important; letter-spacing: var(--tracking-email) !important; }'} :where(img) { max-width: 100%; height: auto; }`;
  email.head.append(style);
  return `<!doctype html>${email.documentElement.outerHTML}`;
}

/** An email's sandboxed document (`doc`, null until the frame's fonts are read, once per session), the copy its layout
 *  is measured from, and why some of its inline images can't be shown. */
export function useEmailDocument({ html, attachmentIds = [], attachmentApi: providedAttachmentApi, respectStyles = false, remoteImages = false, inlineImages }: Omit<EmailPreviewProps, 'title' | 'className'>) {
  const api = useApi();
  const attachmentApi = providedAttachmentApi ?? api.attachments;
  const attachmentKey = [...new Set(attachmentIds)].sort().join(',');
  const [resolved, setResolved] = useState<{html: string; attachmentKey: string; api: AttachmentApi | undefined; sources: Map<string, string>} | null>(null);
  const [error, setError] = useState('');
  const [fontFaces, setFontFaces] = useState<string | null>(null);
  const italic = ITALIC.test(withoutFontStyles(html)), otherScripts = OTHER_SCRIPTS.test(html);
  useEffect(() => {
    let live = true;
    const faces = (italic ? [['normal', 'inter'], ['italic', 'inter-italic']] : [['normal', 'inter']]).flatMap(([style, file]) => [[style, `/fonts/${file}-latin.woff2`, LATIN_RANGE], ...(otherScripts ? [[style, `/fonts/${file}-ext.woff2`, EXT_RANGE]] : [])]);
    Promise.all(faces.map(async ([style, path, range]) => `@font-face { font-family: 'Inter'; src: url('${await fontSource(path)}') format('woff2'); font-style: ${style}; font-weight: 100 900; font-display: swap; unicode-range: ${range}; }`))
      .then(css => { if (live) setFontFaces(css.join(' ')); }).catch(() => { /* Use the font stack's fallback if local fonts are unavailable. */ if (live) setFontFaces(current => current ?? ''); });
    return () => { live = false; };
  }, [italic, otherScripts]);
  // Content-ID → signed link, applied only to exact img[src="cid:…"] matches after sanitizing (L15).
  const inlineKey = JSON.stringify(inlineImages ?? {});
  const inline = useMemo(() => new Map(Object.entries(JSON.parse(inlineKey) as Record<string, string>).flatMap(([id, url]): [string, URL][] => {
    try { const parsed = new URL(url); return parsed.protocol === 'https:' ? [[`cid:${id}`, parsed]] : []; } catch { return []; }
  })), [inlineKey]);
  const needed = useMemo(() => new Set([...cidImageSources(html)].filter(id => !inline.has(`cid:${id}`))), [html, inline]);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    loadInlineAttachments(attachmentApi, attachmentKey ? attachmentKey.split(',') : [], needed, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setResolved({html, attachmentKey, api: attachmentApi, sources: result.sources});
      if (result.sources.size < needed.size) setError('Couldn’t resolve some inline images from this message’s attachments.');
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Inline image preview is unavailable.'); });
    return () => controller.abort();
  }, [html, attachmentKey, attachmentApi, needed]);
  const sources = resolved?.html === html && resolved.attachmentKey === attachmentKey && resolved.api === attachmentApi ? resolved.sources : undefined;
  const options = useMemo(() => ({ respectStyles, remoteImages, inline }), [respectStyles, remoteImages, inline]);
  const doc = useMemo(() => fontFaces === null ? null : emailDocument(html, options, sources, fontFaces), [html, options, sources, fontFaces]);
  const layout = useMemo(() => emailDocument(html, options, undefined, '', true), [html, options]);
  return { doc, layout, error };
}

export function EmailPreview({ title = 'Email preview', className, ...props }: EmailPreviewProps) {
  const { doc, error } = useEmailDocument(props);
  // The first frame waits for the fonts (one read per session), so the preview loads once instead of twice.
  if (doc === null) return <div className={['ui-email-preview', className].filter(Boolean).join(' ')} aria-hidden />;
  // Changing srcdoc on a mounted iframe navigates it, and Chrome adds that navigation to the tab's
  // history: Back then steps the preview instead of leaving the page. A new iframe per document
  // (keyed on its content) loads without a history entry.
  return <>{error && <p className="ui-field__error" role="alert">{error}</p>}<iframe key={doc} title={title} className={['ui-email-preview', className].filter(Boolean).join(' ')} srcDoc={doc} sandbox="" referrerPolicy="no-referrer" /></>;
}
export default EmailPreview;
