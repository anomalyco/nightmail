import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ApiError, type App } from './core.js';
import { servesWorkspace } from './link-domains.js';
import { servedDomains } from './brand.js';

// Campaign mail links its inline pictures instead of carrying them. Each is served at <link origin>/i/<name>, on the same
// host as the message's unsubscribe link (src/link-domains.ts: the link domain, links.nightmailedge.com, on Hosted;
// PUBLIC_URL without link hosts; never Hosted's own domain), the same bytes for every recipient, so a message is its HTML
// (a few KB) rather than its HTML plus every picture: November's 1.8M-recipient newsletter carried a 272 KB PNG in every
// copy, and SES billed 632 GB of attachment data that month.
// The name is the attachment's ID and the first half of its SHA-256, with the type's extension: it can't be guessed
// without both, a secret rotation doesn't change it, and it names no recipient. It answers only on a host that serves its
// workspace's links (servesWorkspace, as the unsubscribe page): this installation's own origins, the link domain once the
// workspace has linked there, or the workspace's own link host (and a retired one for 30 days after its domain is
// deleted). A link works while the attachment exists, and its draft, review and sent mail keep it
// (sending_attachment_links): as long as the campaign does, and for the sending-log retention after it is deleted. Only
// PNG, JPEG, GIF and WebP whose bytes open as their type are linked, here and when served: nothing else (no SVG, no
// document) can be published through the route.

const TYPES = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp']]);
const EXTENSION_TYPES = new Map([...TYPES].map(([type, extension]) => [extension, type]));
/** Larger pictures stay attached: the route answers a link from one buffer. */
export const LINKED_IMAGE_BYTES = 10 * 1024 * 1024;
const NAME = /^([0-9a-f]{32})([0-9a-f]{32})\.(png|jpg|gif|webp)$/;

const extensionOf = (contentType: string) => TYPES.get(contentType.split(';')[0]!.trim().toLowerCase());
/** Whether the bytes open as the picture the extension names. */
function opensAs(bytes: Uint8Array, extension: string) {
  const ascii = (at: number, text: string) => [...text].every((character, i) => bytes[at + i] === character.charCodeAt(0));
  switch (extension) {
    case 'png': return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => bytes[i] === byte);
    case 'jpg': return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'gif': return ascii(0, 'GIF87a') || ascii(0, 'GIF89a');
    case 'webp': return ascii(0, 'RIFF') && ascii(8, 'WEBP');
    default: return false;
  }
}
type LinkableRow = { id: string; checksum: string; contentType: string; size: number; disposition: string; contentId: string | null };
/** Where an inline picture is served, or null when it stays attached. */
export function linkedImagePath(row: LinkableRow, bytes: Uint8Array) {
  const id = /^attachment_([0-9a-f]{32})$/.exec(row.id)?.[1], extension = extensionOf(row.contentType);
  if (!id || !extension || row.disposition !== 'inline' || !/^[0-9a-f]{64}$/.test(row.checksum) || bytes.length !== row.size || bytes.length > LINKED_IMAGE_BYTES || !opensAs(bytes, extension)) return null;
  return `/i/${id}${row.checksum.slice(0, 32)}.${extension}`;
}
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The HTML with each cid: reference to a linkable inline picture replaced by its link, as the visual preview replaces
 * them with the picture (src/preview-images.ts): one pass, longest reference first, never the start of a longer content
 * ID. `linked` names the attachments the message no longer carries; one still referenced in a spelling a client also
 * reads (another case, an entity for the colon) stays attached.
 */
export function linkInlineImages(origin: string, html: string, files: { row: LinkableRow; bytes: Uint8Array }[]) {
  const links = new Map<string, { id: string; url: string }>(), linked = new Set<string>();
  for (const { row, bytes } of files) {
    const path = row.contentId ? linkedImagePath(row, bytes) : null;
    if (path && !links.has(`cid:${row.contentId}`)) links.set(`cid:${row.contentId}`, { id: row.id, url: origin + path });
  }
  if (!links.size) return { html, linked };
  const pattern = new RegExp(`(?:${[...links.keys()].sort((a, b) => b.length - a.length).map(escaped).join('|')})(?![\\w.@-])`, 'g'), used = new Set<string>();
  html = html.replace(pattern, reference => { used.add(reference); return links.get(reference)!.url; });
  for (const reference of used) {
    if (!new RegExp(`cid(?::|&#0*58;?|&#x0*3a;?|&colon;)${escaped(reference.slice(4))}(?![\\w.@-])`, 'i').test(html)) linked.add(links.get(reference)!.id);
  }
  return { html, linked };
}

async function sha256(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), n => n.toString(16).padStart(2, '0')).join('');
}
const missing = () => new ApiError(404, 'NOT_FOUND', 'This image does not exist.');
export function registerLinkedImages(app: App) {
  // Public by design: the name is the only credential, and every copy of the message carries it. Cached for a year
  // everywhere (the Worker keeps a copy in its colo, src/worker.ts): a name always means the same bytes.
  app.get('/i/:name', async c => {
    const match = NAME.exec(c.req.param('name'));
    // Hosted's own domain never serves customer pictures, whatever links an old message carries: only link hosts do.
    if (!match || c.env.config.multiTenant && servedDomains.includes(new URL(c.req.url).hostname.toLowerCase())) throw missing();
    const [, id, hash, extension] = match as unknown as [string, string, string, string];
    const { rows: [row] } = await c.env.db.execute<{ workspace_id: string; storage_key: string; checksum: string; content_type: string; size: number; disposition: string }>(
      sql`SELECT workspace_id, storage_key, checksum, content_type, size, disposition FROM sending_attachments WHERE id = ${`attachment_${id}`}`);
    if (!row || row.disposition !== 'inline' || extensionOf(row.content_type) !== extension || row.size > LINKED_IMAGE_BYTES || row.checksum.length !== 64
      || !timingSafeEqual(Buffer.from(row.checksum.slice(0, 32)), Buffer.from(hash)) || !await servesWorkspace(c.env, c.req.url, row.workspace_id)) throw missing();
    const etag = `"${row.checksum}"`, headers: Record<string, string> = {
      'Content-Type': EXTENSION_TYPES.get(extension)!, 'Cache-Control': 'public, max-age=31536000, immutable', ETag: etag,
      'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline',
      'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Robots-Tag': 'noindex',
    };
    if (c.req.header('if-none-match')?.split(',').some(tag => tag.trim().replace(/^W\//, '') === etag)) return new Response(null, { status: 304, headers });
    const object = await c.env.storage.get(row.storage_key);
    if (!object || object.body.length !== row.size || !opensAs(object.body, extension) || await sha256(object.body) !== row.checksum) throw missing();
    return new Response(object.body as Uint8Array<ArrayBuffer>, { headers: { ...headers, 'Content-Length': String(row.size) } });
  });
}
