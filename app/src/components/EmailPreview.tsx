import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ImageOff } from 'lucide-react';
import { errorText, type AttachmentApi } from '../data/types';
import { useApi } from '../data/context';
import { attachmentKind, cachedInlineAttachments, cidImageSources, loadInlineAttachments } from '../features/campaigns/composer-content';
import { isRasterDataUrl } from '../features/campaigns/block-content';
import { mentionsRemoteImage, withoutFontStyles } from '../lib/html-scan';
import DOMPurify from 'dompurify';
import { heldImageSource, px } from '../lib/held-image';
import { Alert, Button, Tooltip } from './ui';

// Known open-tracking endpoints (ESP pixels, SES open tracking) and generic pixel paths.
const TRACKING_URL = /(?:awstrack\.me|list-manage\.com\/track|\/wf\/open|sendgrid\.net\/wf|mandrillapp\.com\/track|pstmrk\.it|pmtrk|track\.customer\.io\/e\/o|mailgun\.[a-z]+\/o\/|emltrk\.com|sidekickopen|hubspotlinks|mixmax\.com\/api\/track|mailtrack\.io|getnotify\.com|bananatag|yesware)/i;
// Generic pixel paths only count when the URL is not an ordinary image file (e.g. /tracking-logo.png).
const TRACKING_PATH = /\/(?:track|tracking|open|opens|pixel|beacon)(?:[\/.?_-]|$)/i;
const IMAGE_FILE = /\.(?:png|jpe?g|svg|webp|avif)(?:[?#]|$)/i;
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

/** Whether Load images would show anything: an https image that isn't a tracking pixel, or an https CSS background (the
 *  frame's CSP allows only https; an http image never loads, and a remote font isn't an image). */
export function holdsRemoteImages(html: string): boolean {
  if (!mentionsRemoteImage(html)) return false;
  const page = new DOMParser().parseFromString(html, 'text/html');
  return [...page.querySelectorAll('img[src]')].some(image => /^https:\/\//i.test(image.getAttribute('src')!.trim()) && !isTrackingPixel(image))
    || /background(?:-image)?\s*:[^;}"]*url\(\s*['"]?https:\/\//i.test(html);
}

/** The line over a preview whose remote images are held back: what is going on, and Load images. `why` is the reason,
 *  on Load images' tooltip. */
export function HeldImages({ onLoad, why, style }: { onLoad: () => void; why: string; style?: CSSProperties }) {
  return <div className="email-held" style={style}>
    <ImageOff size={14} aria-hidden="true" /><span className="email-held__text">Images in this email aren’t loaded.</span>
    <Tooltip content={why}><Button size="sm" onClick={onLoad}>Load images</Button></Tooltip>
  </div>;
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
  const held = useMemo(() => holdsRemoteImages(props.html), [props.html]);
  return <>{held && !load && <HeldImages why="Remote images are hidden so the sender can’t tell when you open this message." onLoad={() => setLoadedFor(props.html)} />}<EmailPreview {...props} remoteImages={load} /></>;
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

/** inlineImages maps a received message's Content-IDs to its signed https attachment links. asSent lays the email out as
 *  its own HTML does (a sent email's Original): images keep their declared sizes instead of shrinking to the frame. */
export type EmailPreviewProps = { html: string; title?: string; className?: string; attachmentIds?: string[]; attachmentApi?: AttachmentApi; respectStyles?: boolean; remoteImages?: boolean; inlineImages?: Record<string, string>; asSent?: boolean };
type DocumentOptions = { respectStyles: boolean; remoteImages: boolean; inline: Map<string, URL>; asSent: boolean; scheme: 'light' | 'dark' };

/** Whether an email opts in to dark mode, as Apple Mail reads it: a color-scheme meta that names dark and isn't "light
 *  only" (api/src/email-preview's emulation reads the same). Only then does a dark mail client show it dark. */
export function declaresDark(html: string) {
  const schemes = [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('meta[name]')]
    .filter(meta => /^(?:supported-)?color-scheme$/i.test(meta.getAttribute('name') ?? '')).map(meta => (meta.getAttribute('content') ?? '').toLowerCase().trim());
  return schemes.some(scheme => scheme.split(/\s+/).includes('dark')) && !schemes.some(scheme => /^(?:light only|only light)$/.test(scheme));
}

// The preview's document: sanitized, every URL dropped but the images it may show, a CSP that blocks everything else,
// and the frame's base styles. Images load at once (no lazy loading), so a frame measured once they have is final.
// `scheme`: its canvas, light or a dark one (Apple Mail's); the frame it loads in has the same color-scheme, which
// decides whether its `prefers-color-scheme: dark` styles apply (components/EmailFrame.tsx).
function emailDocument(html: string, { respectStyles, remoteImages, inline, asSent, scheme }: DocumentOptions, sources: Map<string, string> | undefined, fontFaces: string) {
  // Authenticated, validated raster data is assigned from the attachment map
  // after DOMPurify; the opaque sandbox never needs access to parent Blob URLs.
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    USE_PROFILES: { html: true },
    ADD_TAGS: ['style'],
    // DOMPurify's default URI rule: a custom ALLOWED_URI_REGEXP also strips ordinary values such as
    // width="1", which hid tracking pixels from isTrackingPixel. Image sources are checked below.
    FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'source', 'link', 'base', 'meta'],
    FORBID_ATTR: ['href', 'srcset', 'ping', 'action', 'formaction', 'target', 'download', 'autofocus', 'xlink:href', 'background', 'loading'],
  });
  const email = new DOMParser().parseFromString(clean, 'text/html');
  email.querySelectorAll('style[data-bane-fonts], style[data-opensend-fonts]').forEach(style => style.remove());
  email.querySelectorAll('[src]').forEach(element => {
    const source = element.getAttribute('src') ?? '';
    const owned = element.tagName === 'IMG' ? sources?.get(source) ?? inline.get(source)?.href : undefined;
    if (owned) element.setAttribute('src', owned);
    // A tracking pixel is never drawn, loaded or held: it has nothing to show.
    else if (element.tagName === 'IMG' && /^https?:\/\//i.test(source) && isTrackingPixel(element)) element.remove();
    else if (element.tagName !== 'IMG') element.removeAttribute('src');
    else if (!(isRasterDataUrl(source) || (remoteImages && /^https:\/\//i.test(source)))) element.setAttribute('src', heldImageSource(element));
  });
  // A frame's `prefers-color-scheme` follows the system, not the frame's color-scheme, in Chrome: the email's light and
  // dark media queries are settled here for the document's scheme, so its dark styles never land on the light canvas.
  const settle = (media: string) => media.replace(/\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi, (_, wanted: string) => wanted.toLowerCase() === scheme ? '(min-width:0px)' : '(max-width:0px)');
  email.querySelectorAll('style').forEach(style => { style.textContent = settle(style.textContent ?? ''); if (style.media) style.media = settle(style.media); });
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
  style.textContent = `${fontFaces} :root { --font-email: ${tokens.getPropertyValue('--font-email')}; --tracking-email: ${tokens.getPropertyValue('--tracking-email')}; --color-text: ${tokens.getPropertyValue(scheme === 'dark' ? '--color-email-dark-text' : '--color-email-text')}; --color-surface: ${tokens.getPropertyValue(scheme === 'dark' ? '--color-email-dark-surface' : '--color-email-surface')}; } :where(html) { color-scheme: ${scheme}; background: var(--color-surface); color: var(--color-text); scrollbar-width: none; } ::-webkit-scrollbar { display: none; } :where(body) { margin: 24px; line-height: 1.5; overflow-wrap: anywhere; font-family: var(--font-email); letter-spacing: var(--tracking-email); } ${respectStyles ? '' : 'body, body * { font-family: var(--font-email) !important; letter-spacing: var(--tracking-email) !important; }'}${asSent ? '' : ' :where(img) { max-width: 100%; height: auto; }'}`;
  email.head.append(style);
  return `<!doctype html>${email.documentElement.outerHTML}`;
}

/** An email's sandboxed document (`doc`, null until the frame's fonts are read, once per session), whether its inline
 *  images are in it yet (`complete`), why some of them can't be shown, and whether remote images are held back that
 *  Load images would show (`held`). With `dark`, also `darkDoc`: the document
 *  on a dark canvas when the email opts in to dark mode (declaresDark), otherwise undefined. */
export function useEmailDocument({ html, attachmentIds = [], attachmentApi: providedAttachmentApi, respectStyles = false, remoteImages = false, inlineImages, asSent = false, dark = false }: Omit<EmailPreviewProps, 'title' | 'className'> & { dark?: boolean }) {
  const api = useApi();
  const cache = useQueryClient();
  const attachmentApi = providedAttachmentApi ?? api.attachments;
  const kind = attachmentKind(api, providedAttachmentApi);
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
  const cachedSync = useMemo(() => {
    if (!needed.size) return new Map<string, string>();
    const ids = attachmentKey ? attachmentKey.split(',') : [];
    const hit = cachedInlineAttachments(kind, ids, needed);
    return hit.missing.size === 0 ? hit.sources : undefined;
  }, [kind, attachmentKey, needed]);
  useEffect(() => {
    if (cachedSync) return;
    const controller = new AbortController();
    setError('');
    loadInlineAttachments(attachmentApi, attachmentKey ? attachmentKey.split(',') : [], needed, controller.signal, { cache, kind }).then(result => {
      if (controller.signal.aborted) return;
      setResolved({html, attachmentKey, api: attachmentApi, sources: result.sources});
      if (result.sources.size < needed.size) setError('Couldn’t resolve some inline images from this message’s attachments.');
    }).catch(cause => { if (!controller.signal.aborted) setError(errorText(cause, 'Inline image preview is unavailable.')); });
    return () => controller.abort();
  }, [html, attachmentKey, attachmentApi, needed, cache, kind, cachedSync]);
  const sources = cachedSync ?? (resolved?.html === html && resolved.attachmentKey === attachmentKey && resolved.api === attachmentApi ? resolved.sources : undefined);
  const options = useMemo(() => ({ respectStyles, remoteImages, inline, asSent }), [respectStyles, remoteImages, inline, asSent]);
  const doc = useMemo(() => fontFaces === null ? null : emailDocument(html, { ...options, scheme: 'light' }, sources, fontFaces), [html, options, sources, fontFaces]);
  const hasDark = useMemo(() => dark && declaresDark(html), [dark, html]);
  const darkDoc = useMemo(() => !hasDark ? undefined : fontFaces === null ? null : emailDocument(html, { ...options, scheme: 'dark' }, sources, fontFaces), [hasDark, html, options, sources, fontFaces]);
  const held = useMemo(() => !remoteImages && holdsRemoteImages(html), [html, remoteImages]);
  return { doc, darkDoc, complete: Boolean(sources) || error !== '', error, held };
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
