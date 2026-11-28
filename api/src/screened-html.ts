// The HTML a probation sender's message is delivered as: the copy the content screen read. Style sheet rules are
// first inlined onto the elements they select (specificity and source order, like a mail inliner; at-rules and
// pseudo-elements are left out), then the markup is reduced to the elements and inline styles a mail client shows as
// text. Nothing that hides, moves, shrinks, recolors or generates text survives: no style sheets, scripts, comments,
// conditional comments, templates, noscript, foreign content or form controls; no visibility, opacity, position,
// float, clip, transform, overflow, filter, blend mode, generated content, bidi override, negative spacing, type under
// 8 px, background images, or text in its background color. An element the light-scheme rendering does not display
// (display:none, the hidden attribute) is left out with its content, so a dark-mode image swap resolves to the light
// image and a mobile-only block to its desktop state. What a recipient can read is then exactly the text the screen
// reads. One hidden block is kept: the preheader, the first text of the message when its own style hides it, at most
// 300 characters of plain text, which is screened like the rest. Text the markup would draw without screened words
// (list markers with letters or chosen numbers, list items without text) is left out, images count by their declared
// size against the words beside them, and the bidi controls, directions and layout properties that reorder what a
// client draws are removed from every textual field and element. Senders off probation keep their markup; the image rule
// and the picture checks on attachments (hostedCopy, shownAttachment) apply to them too, as the screen reads no picture.
import { defaultTreeAdapter, html as spec, serializeOuter, type DefaultTreeAdapterMap } from 'parse5';
import { boundedHtmlFragment } from './bounded-html.js';
import { ApiError } from './core.js';

type Node = DefaultTreeAdapterMap['childNode'];
type Element = DefaultTreeAdapterMap['element'];
type Parent = DefaultTreeAdapterMap['parentNode'];
const HTML = spec.NS.HTML;
const isElement = (node: Node): node is Element => 'tagName' in node;
const isText = (node: Node): node is DefaultTreeAdapterMap['textNode'] => node.nodeName === '#text';
const tooLarge = () => new ApiError(422, 'CONTENT_TOO_LARGE_TO_SCREEN', 'Shorten the message so Hosted sending can screen it.');
// Embeddings, overrides and isolates reorder what a client draws, so a probation message's text is delivered without
// them in every field; the weak marks that only place punctuation stay.
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;
export const screenedText = (value: string) => value.replace(BIDI_CONTROLS, '');
/** A file name as a client shows it: no format characters or other default-ignorable code points at all. */
export const screenedName = (value: string) => value.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '');
/** Words made of characters a client draws: letters and digits that are not default-ignorable (Hangul fillers and
 *  the like render as blanks). The one definition of a word wherever the screen counts text. */
export const VISIBLE_WORDS = /(?:(?!\p{Default_Ignorable_Code_Point})[\p{L}\p{N}])+/gu;
export const visibleWords = (text: string) => text.match(VISIBLE_WORDS)?.length ?? 0;
// Pictures carry words the screen cannot read: a probation message is refused when its images, by the size a client
// draws them at, outweigh the words beside them. A 200 x 200 logo needs none; every further 600 x 300 needs 25 words.
const IMAGE_FREE_PIXELS = 200 * 200, IMAGE_PIXELS_PER_WORD = 600 * 300 / 25;
const imageOnly = () => new ApiError(422, 'CONTENT_IMAGE_ONLY', 'Add body text beside the images so Hosted sending can screen the message.');

// ----- Attachments --------------------------------------------------------------------------------------------------

// What a probation sender may attach: a standard extension whose declared type and bytes agree with it. Inline
// attachments must be raster images. Anything a client renders as a document of text the screen never read (markup,
// mail) is refused whatever it is called. A mail app's files are judged by their bytes instead (mailAppAttachment).
type Family = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'tiff' | 'pdf' | 'zip' | 'ole' | 'gzip' | '7z' | 'rar' | 'mp3' | 'mp4' | 'wav' | 'ogg' | 'webm' | 'rtf';
const ATTACHMENT_TYPES: Record<string, { types: string[]; family?: Family }> = {
  png: { types: ['image/png'], family: 'png' }, jpg: { types: ['image/jpeg'], family: 'jpeg' }, jpeg: { types: ['image/jpeg'], family: 'jpeg' }, gif: { types: ['image/gif'], family: 'gif' },
  webp: { types: ['image/webp'], family: 'webp' }, bmp: { types: ['image/bmp', 'image/x-ms-bmp'], family: 'bmp' }, tif: { types: ['image/tiff'], family: 'tiff' }, tiff: { types: ['image/tiff'], family: 'tiff' },
  pdf: { types: ['application/pdf'], family: 'pdf' }, zip: { types: ['application/zip', 'application/x-zip-compressed'], family: 'zip' }, gz: { types: ['application/gzip', 'application/x-gzip'], family: 'gzip' },
  '7z': { types: ['application/x-7z-compressed'], family: '7z' }, rar: { types: ['application/vnd.rar', 'application/x-rar-compressed'], family: 'rar' },
  docx: { types: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], family: 'zip' }, xlsx: { types: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], family: 'zip' },
  pptx: { types: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'], family: 'zip' }, odt: { types: ['application/vnd.oasis.opendocument.text'], family: 'zip' },
  ods: { types: ['application/vnd.oasis.opendocument.spreadsheet'], family: 'zip' }, odp: { types: ['application/vnd.oasis.opendocument.presentation'], family: 'zip' },
  doc: { types: ['application/msword'], family: 'ole' }, xls: { types: ['application/vnd.ms-excel'], family: 'ole' }, ppt: { types: ['application/vnd.ms-powerpoint'], family: 'ole' },
  mp3: { types: ['audio/mpeg'], family: 'mp3' }, mp4: { types: ['video/mp4'], family: 'mp4' }, m4a: { types: ['audio/mp4', 'audio/x-m4a'], family: 'mp4' }, wav: { types: ['audio/wav', 'audio/x-wav', 'audio/wave'], family: 'wav' },
  ogg: { types: ['audio/ogg', 'video/ogg', 'application/ogg'], family: 'ogg' }, webm: { types: ['video/webm', 'audio/webm'], family: 'webm' }, rtf: { types: ['application/rtf', 'text/rtf'], family: 'rtf' },
  txt: { types: ['text/plain'] }, log: { types: ['text/plain'] }, csv: { types: ['text/csv'] }, tsv: { types: ['text/tab-separated-values'] }, json: { types: ['application/json'] }, ics: { types: ['text/calendar'] }, vcf: { types: ['text/vcard', 'text/x-vcard'] }, md: { types: ['text/markdown'] },
};
const RASTER = new Set<Family>(['png', 'jpeg', 'gif', 'webp', 'bmp']);
/** What a family's bytes are, for a refusal that says what a file's content looks like. */
const FAMILY_NAMES: Record<Family, string> = { png: 'a PNG image', jpeg: 'a JPEG image', gif: 'a GIF image', webp: 'a WebP image', bmp: 'a BMP image', tiff: 'a TIFF image', pdf: 'a PDF',
  zip: 'a ZIP archive (as DOCX, XLSX, PPTX and OpenDocument files are)', ole: 'an older Office document (DOC, XLS, PPT)', gzip: 'a gzip archive', '7z': 'a 7z archive', rar: 'a RAR archive',
  mp3: 'an MP3', mp4: 'an MP4 or M4A', wav: 'a WAV', ogg: 'an Ogg file', webm: 'a WebM', rtf: 'an RTF document' };
/** The type a family's bytes are sent as when nothing names one of its types; none where the bytes can't tell which
 *  (an OLE file is a Word, Excel or PowerPoint file or an installer, ISO media an MP4, M4A, MOV or HEIC file, EBML a
 *  WebM or Matroska file), so application/octet-stream. */
const FAMILY_TYPES: Record<Family, string | undefined> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tiff: 'image/tiff', pdf: 'application/pdf',
  zip: 'application/zip', ole: undefined, gzip: 'application/gzip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', mp3: 'audio/mpeg', mp4: undefined, wav: 'audio/wav',
  ogg: 'application/ogg', webm: undefined, rtf: 'application/rtf' };
const PROBATION = 'while the sender is on probation';
/** The kinds of file the standard extensions are, for a person reading a refusal. */
const STANDARD_KINDS = 'images, PDFs, office documents, archives, audio, video and text files';
/** Bytes that are themselves base64 text: a file encoded twice, the commonest way an upload's content goes wrong. */
const base64Text = (bytes: Uint8Array) => bytes.length >= 16 && bytes.subarray(0, 4096).every(b => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2f || b === 0x3d || b === 0x2d || b === 0x5f || b === 0x0a || b === 0x0d);
/** What a file's content is, without any of it: its size and what its first bytes announce, and a fix when it shows one. */
function contentOf(bytes: Uint8Array) {
  const found = signature(bytes), size = `${bytes.length.toLocaleString('en-US')} bytes`;
  if (found) return { what: `${size} that start like ${FAMILY_NAMES[found]}`, fix: '' };
  return base64Text(bytes) ? { what: `${size} of base64 text`, fix: ' (the file was encoded twice: upload the decoded bytes)' } : { what: `${size} that match no known file signature`, fix: '' };
}
const DOCUMENT_TYPES = new Set(['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'message/rfc822', 'multipart/related', 'application/x-mimearchive']);
const DOCUMENT_EXTENSIONS = new Set(['svg', 'svgz', 'html', 'htm', 'xhtml', 'xht', 'xml', 'mht', 'mhtml', 'eml']);
/** Readers of a file's first bytes: hex bytes or ASCII text at an offset, and a little-endian 32-bit number. */
function reader(bytes: Uint8Array) {
  return {
    at: (offset: number, hex: string) => hex.split(' ').every((byte, i) => bytes[offset + i] === parseInt(byte, 16)),
    ascii: (offset: number, text: string) => [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0)),
    u32: (offset: number) => ((bytes[offset] ?? 0) | (bytes[offset + 1] ?? 0) << 8 | (bytes[offset + 2] ?? 0) << 16) + (bytes[offset + 3] ?? 0) * 2 ** 24,
  };
}
/** The family the first bytes announce, if this reader knows it. */
function signature(bytes: Uint8Array): Family | undefined {
  const { at, ascii, u32 } = reader(bytes);
  if (at(0, '89 50 4e 47 0d 0a 1a 0a')) return 'png';
  if (at(0, 'ff d8 ff')) return 'jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'wav';
  // BM and a bitmap header's size: text that starts with "BM" is not a bitmap.
  if (ascii(0, 'BM') && [12, 16, 40, 52, 56, 64, 108, 124].includes(u32(14))) return 'bmp';
  if (at(0, '49 49 2a 00') || at(0, '4d 4d 00 2a')) return 'tiff';
  if (ascii(0, '%PDF-')) return 'pdf';
  if (at(0, '50 4b 03 04') || at(0, '50 4b 05 06')) return 'zip';
  if (at(0, 'd0 cf 11 e0 a1 b1 1a e1')) return 'ole';
  if (at(0, '1f 8b')) return 'gzip';
  if (at(0, '37 7a bc af 27 1c')) return '7z';
  if (ascii(0, 'Rar!')) return 'rar';
  if (ascii(0, 'ID3') || at(0, 'ff fb') || at(0, 'ff f3') || at(0, 'ff f2')) return 'mp3';
  if (ascii(4, 'ftyp')) return 'mp4';
  if (ascii(0, 'OggS')) return 'ogg';
  if (at(0, '1a 45 df a3')) return 'webm';
  if (ascii(0, '{\\rtf')) return 'rtf';
  return undefined;
}
/** Bytes a client would render as markup or as a mail message, and which. */
function document(bytes: Uint8Array): 'markup' | 'mail' | undefined {
  let head = ''; for (const byte of bytes.subarray(0, 4096)) head += String.fromCharCode(byte);
  const text = head.replace(/^(?:\xef\xbb\xbf|\xff\xfe|\xfe\xff)?\s*/, '').toLowerCase();
  return text.startsWith('<') ? 'markup' : /^[a-z][\w-]*:\s/.test(text) && /\n(?:mime-version|content-type):/.test(text) ? 'mail' : undefined;
}
/** A program, whatever the file is called: what a recipient's system would run. */
function program(bytes: Uint8Array) {
  const { at, ascii, u32 } = reader(bytes);
  if (ascii(0, 'MZ') && at(u32(0x3c), '50 45 00 00')) return 'a Windows program';
  if (at(0, '7f 45 4c 46')) return 'a Linux program';
  if (['fe ed fa ce', 'fe ed fa cf', 'ce fa ed fe', 'cf fa ed fe', 'ca fe ba be'].some(hex => at(0, hex))) return 'a Mac or Java program';
  if (ascii(0, '#!/') || ascii(0, '#! /')) return 'a script';
  if (at(0, '4c 00 00 00 01 14 02 00')) return 'a Windows shortcut';
  if (ascii(0, 'ITSF')) return 'a Windows help file';
  if (ascii(0, 'MSCF')) return 'a Windows installer cabinet';
  return undefined;
}
/** Bytes that read as text: UTF-16 after its byte-order mark, or an 8-bit charset with no control characters but tab,
 *  line breaks, form feed and escape, over the first 64 KiB. */
function textBytes(bytes: Uint8Array) {
  const head = bytes.subarray(0, 65536), utf16 = head[0] === 0xff && head[1] === 0xfe ? 'utf-16le' : head[0] === 0xfe && head[1] === 0xff ? 'utf-16be' : undefined;
  if (utf16) return !/[\x00-\x08\x0b\x0e-\x1a\x1c-\x1f]/.test(new TextDecoder(utf16).decode(head.subarray(2, head.length - (head.length % 2))));
  return head.every(b => b >= 0x20 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x1b);
}
/** A refused attachment's types, for the request log: what its declared type and name's extension say and what its
 *  bytes are, as MIME type shapes and fixed words, never its name or content. */
function attachmentTypes(type: string, extension: string, bytes: Uint8Array) {
  const detectedType = program(bytes) ? 'program' : svgBytes(bytes) ? 'svg' : document(bytes) ?? signature(bytes) ?? (textBytes(bytes) ? 'text' : 'unknown');
  return { declaredType: /^[a-z0-9][\w.+-]{0,63}\/[a-z0-9][\w.+-]{0,63}$/.test(type) ? type : 'other', detectedType, extension: !extension ? 'none' : /^[a-z0-9]{1,10}$/.test(extension) ? extension : 'other' };
}
/** A file's name with format characters removed, the extension a system opens it by (after trailing dots and spaces,
 *  which Windows ignores), and its declared type without parameters. */
function labels(filename: string, contentType: string) {
  const name = screenedName(filename).replace(/[. ]+$/, '');
  return { name, shown: JSON.stringify(name), extension: name.includes('.') ? name.split('.').pop()!.toLowerCase() : '', type: contentType.split(';')[0]!.trim().toLowerCase() };
}
/** An attachment refusal that the request log can describe by its types (attachmentTypes). */
function refusal(code: string, message: string, types: ReturnType<typeof attachmentTypes>) {
  const error = new ApiError(422, code, message);
  error.attachmentTypes = types;
  return error;
}
/** The name and type a probation sender's attachment is delivered under, or the reason it is not: its declared type
 *  (application/octet-stream meaning unspecified), normalized extension and bytes must agree. */
export function screenedAttachment(filename: string, contentType: string, bytes: Uint8Array, inline: boolean): { filename: string; contentType: string } {
  const { shown, extension, type } = labels(filename, contentType), types = () => attachmentTypes(type, extension, bytes);
  const unscreenable = (why: string) => refusal('ATTACHMENT_TYPE_UNSCREENABLE', `Hosted sending cannot screen ${shown}: ${why} ${PROBATION}.`, types());
  const mismatch = (why: string) => refusal('ATTACHMENT_CONTENT_MISMATCH', `Hosted sending cannot deliver ${shown}: ${why}. Its name, declared type and content must agree ${PROBATION}.`, types());
  const markup = DOCUMENT_TYPES.has(type) ? `its type is ${type}` : DOCUMENT_EXTENSIONS.has(extension) ? `its name ends in .${extension}`
    : svgBytes(bytes) ? 'its content is SVG markup' : document(bytes) ? 'its content is markup or a mail message' : null;
  if (markup) throw unscreenable(`${markup}, and markup, SVG and mail archives are not delivered`);
  const expected = own(ATTACHMENT_TYPES, extension);
  if (!expected) throw mismatch(`${extension ? `.${extension} is not` : 'a name without an extension is not'} one of the standard types it delivers: ${Object.keys(ATTACHMENT_TYPES).map(e => `.${e}`).join(', ')}`);
  const says = expected.family ? FAMILY_NAMES[expected.family] : `text (${expected.types[0]})`;
  if (type !== 'application/octet-stream' && !expected.types.includes(type)) throw mismatch(`its declared type is ${type}, but a .${extension} file is ${expected.types.join(' or ')} (or application/octet-stream, to use that)`);
  const found = signature(bytes);
  if (expected.family ? found !== expected.family : found !== undefined) {
    const content = contentOf(bytes);
    throw mismatch(`its content is ${content.what}, but its name (.${extension})${type === 'application/octet-stream' ? ' says' : ` and declared type (${type}) say`} ${says}${content.fix}`);
  }
  if (inline && !RASTER.has(expected.family!)) throw unscreenable(`it is inline (disposition inline), and inline attachments must be PNG, JPEG, GIF, WebP or BMP images; it is ${says}, so send it with disposition attachment`);
  return { filename: screenedName(filename), contentType: type === 'application/octet-stream' ? expected.types[0]! : contentType };
}
/** Bytes that open as SVG markup. */
const svgBytes = (bytes: Uint8Array) => { let head = ''; for (const byte of bytes.subarray(0, 4096)) head += String.fromCharCode(byte); return /<svg[\s>/]/i.test(head); };
/**
 * What every Hosted sender may attach, on probation or not, since the screen reads no picture: no SVG (by type, name or
 * content), and inline (cid:) parts only as raster images whose extension, declared type and bytes agree. The rest of
 * the allowlist (screenedAttachment) is for probation.
 */
export function shownAttachment(filename: string, contentType: string, bytes: Uint8Array, inline: boolean) {
  const { shown, extension, type } = labels(filename, contentType);
  const unscreenable = (why: string) => refusal('ATTACHMENT_TYPE_UNSCREENABLE', `Hosted sending cannot screen ${shown}: ${why}.`, attachmentTypes(type, extension, bytes));
  const svg = type === 'image/svg+xml' ? `its type is ${type}` : extension === 'svg' || extension === 'svgz' ? `its name ends in .${extension}` : svgBytes(bytes) ? 'its content is SVG markup' : null;
  if (svg) throw unscreenable(`${svg}, and SVG images are not delivered: convert it to PNG`);
  if (!inline) return;
  const expected = own(ATTACHMENT_TYPES, extension), found = signature(bytes);
  if (!expected?.family || !RASTER.has(expected.family) || found !== expected.family || (type !== 'application/octet-stream' && !expected.types.includes(type)))
    throw unscreenable(`it is inline (disposition inline), and an inline attachment must be a PNG, JPEG, GIF, WebP or BMP image whose name, declared type and content agree; its name is .${extension || '(none)'}, its declared type ${type}, and its content ${contentOf(bytes).what}. Send it with disposition attachment, or as one of those images`);
}
/**
 * A mail app's file (EmailSnapshot.mailApp) on a Hosted sender's rules: the name, type and disposition it goes out
 * under, or why it doesn't. A mail app labels a file as its system does (application/octet-stream for anything,
 * text/plain for a CSV, image/jpg, no name for a pasted picture, inline for a PDF) and its user can't change that, so a
 * label is never refused here: the bytes say what the file is and it goes out as that, under the type they show
 * (application/octet-stream where they can't tell which of a family's types), with its name kept, and inline only as a
 * raster image (anything else as an ordinary attachment). What a label can't make safe is still refused whatever the file
 * is called: SVG, which a client draws with text the screen never read; and on probation, as screenedAttachment does,
 * markup and mail, a name whose extension isn't a standard one (the extension is what a recipient's system opens it by),
 * and bytes that are a program, or that are no type this reader knows under a name that isn't a text type.
 */
export function mailAppAttachment(filename: string, contentType: string, bytes: Uint8Array, inline: boolean, probation: boolean): DeliveredAttachment {
  const { shown, extension, type } = labels(filename, contentType);
  const refuse = (code: string, why: string) => refusal(code, `attachment ${shown} ${why}`, attachmentTypes(type, extension, bytes));
  if (type === 'image/svg+xml' || extension === 'svg' || extension === 'svgz' || svgBytes(bytes)) throw refuse('ATTACHMENT_TYPE_UNSCREENABLE', 'is an SVG image, and SVG images are never sent: send it as a PNG or JPEG instead');
  const found = signature(bytes), raster = !!found && RASTER.has(found);
  if (!probation) return { filename, contentType: raster && inline ? sameType(contentType, familyType(found!, extension, type)) : contentType, inline: inline && raster };
  const archive = DOCUMENT_TYPES.has(type) && !/html|xml/.test(type) || ['mht', 'mhtml', 'eml'].includes(extension) || document(bytes) === 'mail';
  if (archive || DOCUMENT_TYPES.has(type) || DOCUMENT_EXTENSIONS.has(extension) || document(bytes))
    throw refuse('ATTACHMENT_TYPE_UNSCREENABLE', archive ? `is an attached email or web archive, which can't be sent ${PROBATION}: forward the email inline instead` : `is a web page or XML file, which can't be sent ${PROBATION}: send it as a PDF instead`);
  const runs = program(bytes);
  if (runs) throw refuse('ATTACHMENT_CONTENT_MISMATCH', `is ${runs}, whatever it is called, and programs are never sent`);
  const named = extension ? own(ATTACHMENT_TYPES, extension) : undefined;
  if (extension && !named) throw refuse('ATTACHMENT_CONTENT_MISMATCH', `has a name ending in .${extension}, and ${PROBATION} only ${STANDARD_KINDS} can be sent`);
  // Bytes of no type this reader knows go out only under a text type's name, as screenedAttachment lets them.
  const unknown = !found && !textBytes(bytes), textName = named && !named.family;
  // Text under an office or other binary format's name opens in the app that name picks, and Word and Excel render the
  // markup they find anywhere in it, past whatever text comes first.
  if (!found && !unknown && named?.family && tagged(bytes))
    throw refuse('ATTACHMENT_TYPE_UNSCREENABLE', `is a web page or XML file, which can't be sent ${PROBATION}: send it as a PDF instead`);
  if (unknown && !textName) throw refuse('ATTACHMENT_CONTENT_MISMATCH', `isn't ${named?.family ? `${FAMILY_NAMES[named.family]} or any other` : 'any'} file type Nightmail recognizes, and ${PROBATION} only files it recognizes can be sent`);
  const delivered = found ? familyType(found, extension, type) : unknown ? 'application/octet-stream' : textName ? named.types.includes(type) ? type : named.types[0]! : 'text/plain';
  return { filename: screenedName(filename), contentType: sameType(contentType, delivered), inline: inline && raster };
}
export type DeliveredAttachment = { filename: string; contentType: string; inline: boolean };
/** Bytes with a markup tag anywhere: '<' then a letter, '/', '!' or '?'. */
function tagged(bytes: Uint8Array) {
  for (let i = bytes.indexOf(0x3c); i >= 0 && i < bytes.length - 1; i = bytes.indexOf(0x3c, i + 1)) {
    const next = bytes[i + 1]! | 0x20;
    if ((next >= 0x61 && next <= 0x7a) || bytes[i + 1] === 0x2f || bytes[i + 1] === 0x21 || bytes[i + 1] === 0x3f) return true;
  }
  return false;
}
/** The type a family's bytes go out as: the declared one when it is one of the family's types, else the one the name's
 *  extension gives the family, else the family's own (FAMILY_TYPES). */
function familyType(found: Family, extension: string, type: string) {
  if (Object.values(ATTACHMENT_TYPES).some(t => t.family === found && t.types.includes(type))) return type;
  const named = own(ATTACHMENT_TYPES, extension);
  return named?.family === found ? named.types[0]! : FAMILY_TYPES[found] ?? 'application/octet-stream';
}
/** The delivered type with the declared one's parameters when it is the declared type, and its charset when text. */
function sameType(contentType: string, delivered: string) {
  if (contentType.split(';')[0]!.trim().toLowerCase() === delivered) return contentType;
  const charset = delivered.startsWith('text/') ? /;\s*charset\s*=\s*"?([\w.:-]{1,40})"?/i.exec(contentType)?.[1] : undefined;
  return charset ? `${delivered}; charset=${charset}` : delivered;
}
/** The name, type and disposition a Hosted sender's file goes out under, or why it doesn't: a mail app's by its bytes
 *  (mailAppAttachment), others' on probation by the allowlist (screenedAttachment), otherwise by the picture checks
 *  (shownAttachment). Accepting a send and dispatching it both ask. */
export function hostedAttachment(file: { filename: string; contentType: string; disposition: string }, bytes: Uint8Array, probation: boolean, mailApp: boolean): DeliveredAttachment {
  const inline = file.disposition === 'inline';
  if (mailApp) return mailAppAttachment(file.filename, file.contentType, bytes, inline, probation);
  if (probation) return { ...screenedAttachment(file.filename, file.contentType, bytes, inline), inline };
  shownAttachment(file.filename, file.contentType, bytes, inline);
  return { filename: file.filename, contentType: file.contentType, inline };
}
/** A record's own entry, never an inherited one: tag, attribute and property names come from the message. */
const own = <T>(record: Record<string, T>, key: string): T | undefined => Object.hasOwn(record, key) ? record[key] : undefined;

// ----- Values ------------------------------------------------------------------------------------------------------

const codePoint = (n: number) => n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? '\ufffd' : String.fromCodePoint(n);
/** CSS text with its escapes decoded, as a client's tokenizer reads them (\61 is a). */
export const unescapeCss = (s: string) => s.replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|\r\n|[\n\r\f]|([\s\S]))/g, (_, hex?: string, char?: string) => hex ? codePoint(parseInt(hex, 16)) : char ?? '');

type Rgb = [number, number, number];
const NAMED = new Map<string, Rgb>(('aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32')
  .split(' ').map(entry => { const [name, hex] = entry.split(':') as [string, string]; return [name, [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) as Rgb]; }));
/** A plain color (hex, rgb(), rgba(), named) as RGB and alpha; anything else, transparent and currentcolor included, is not one. */
function colorOf(token: string): { rgb: Rgb; alpha: number } | undefined {
  const v = token.toLowerCase();
  const named = NAMED.get(v);
  if (named) return { rgb: named, alpha: 1 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const long = hex.length <= 4 ? [...hex].map(c => c + c).join('') : hex, at = (i: number) => parseInt(long.slice(i, i + 2), 16);
    return { rgb: [at(0), at(2), at(4)], alpha: long.length === 8 ? at(6) / 255 : 1 };
  }
  const rgb = /^rgba?\((\d{1,3}%?),(\d{1,3}%?),(\d{1,3}%?)(?:,(\d*\.?\d+%?))?\)$/.exec(v);
  if (!rgb) return undefined;
  const channel = (s: string) => Math.min(255, s.endsWith('%') ? Math.round(parseFloat(s) * 2.55) : Number(s));
  const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
  return { rgb: [channel(rgb[1]!), channel(rgb[2]!), channel(rgb[3]!)], alpha: Math.min(1, Math.max(0, alpha)) };
}
const blend = (over: Rgb, alpha: number, under: Rgb): Rgb => over.map((c, i) => Math.round(c * alpha + under[i]! * (1 - alpha))) as Rgb;
const luminance = (c: Rgb) => { const lin = (n: number) => { const s = n / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); };
const contrast = (a: Rgb, b: Rgb) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]; return (high + 0.05) / (low + 0.05); };
const READABLE = 1.6, MIN_FONT_PX = 8;

/** A length in px; em and rem at the given size, pt at 4/3, % of the given base. Undefined for anything else. */
function px(token: string, em = 16, base = em): number | undefined {
  const m = /^(-?\d*\.?\d+)(px|pt|em|rem|%)?$/.exec(token);
  if (!m) return undefined;
  const n = parseFloat(m[1]!);
  switch (m[2]) { case 'px': return n; case 'pt': return n * 4 / 3; case 'em': return n * em; case 'rem': return n * 16; case '%': return n * base / 100; default: return n === 0 ? 0 : undefined; }
}
const KEYWORD_PX: Record<string, number> = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
const fontPx = (token: string, parent: number) => own(KEYWORD_PX, token) ?? (token === 'larger' ? parent * 1.2 : token === 'smaller' ? parent / 1.2 : px(token, parent, parent));
const family = (v: string) => /^[\w\s,'"-]+$/.test(v) ? v : undefined;
const lineHeight = (v: string) => v === 'normal' || /^\d*\.?\d+$/.test(v) && parseFloat(v) >= 0.8 || (px(v, 16, 16) ?? 0) >= 10 ? v : undefined;
const within = (token: string, max: number) => { const n = px(token, 16, 300); return n !== undefined && n >= 0 && n <= max; };
const keywords = (...words: string[]) => (v: string) => words.includes(v) ? v : undefined;
const each = (ok: (token: string) => boolean, max = 4) => (v: string) => { const tokens = v.split(' '); return tokens.length <= max && tokens.every(ok) ? v : undefined; };
const BORDER_STYLE = ['none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'];
const borderToken = (t: string) => ['thin', 'medium', 'thick', ...BORDER_STYLE].includes(t) || within(t, 50) || !!colorOf(t);
// Markers that spell nothing: bullets, or the item's own count.
const LIST_TYPES = ['none', 'disc', 'circle', 'square', 'decimal'];
/** Inline properties a client may apply, each with the values it may take. Colors and sizes are handled with the element's state. */
const PROPERTIES: Record<string, (value: string) => string | undefined> = {
  'font-family': family, 'font-weight': keywords('normal', 'bold', 'bolder', 'lighter', '100', '200', '300', '400', '500', '600', '700', '800', '900'),
  'font-style': keywords('normal', 'italic', 'oblique'), 'font-variant': keywords('normal', 'small-caps'), 'line-height': lineHeight,
  'letter-spacing': v => v === 'normal' || within(v, 20) ? v : undefined, 'word-spacing': v => v === 'normal' || within(v, 40) ? v : undefined,
  'text-align': keywords('left', 'right', 'center', 'justify', 'start', 'end'), 'text-transform': keywords('none', 'uppercase', 'lowercase', 'capitalize'),
  'vertical-align': v => ['baseline', 'sub', 'super', 'top', 'text-top', 'middle', 'bottom', 'text-bottom'].includes(v) || Math.abs(px(v) ?? Infinity) <= 50 ? v : undefined,
  'text-decoration': each(t => ['none', 'underline', 'overline', 'line-through', 'solid', 'double', 'dotted', 'dashed', 'wavy'].includes(t) || !!colorOf(t)),
  'text-decoration-line': each(t => ['none', 'underline', 'overline', 'line-through'].includes(t)), 'text-decoration-style': keywords('solid', 'double', 'dotted', 'dashed', 'wavy'), 'text-decoration-color': v => colorOf(v) ? v : undefined,
  'white-space': keywords('normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line'), 'word-break': keywords('normal', 'break-all', 'keep-all', 'break-word'),
  'overflow-wrap': keywords('normal', 'break-word', 'anywhere'), 'word-wrap': keywords('normal', 'break-word'),
  display: keywords('block', 'inline', 'inline-block', 'list-item'), 'box-sizing': keywords('border-box', 'content-box'), 'table-layout': keywords('auto', 'fixed'),
  'list-style-type': keywords(...LIST_TYPES), 'list-style-position': keywords('inside', 'outside'), 'list-style': each(t => LIST_TYPES.includes(t) || t === 'inside' || t === 'outside', 2),
  'border-collapse': keywords('collapse', 'separate'), 'border-spacing': each(t => within(t, 50), 2), 'border-radius': each(t => within(t, 300)),
  '-webkit-text-size-adjust': keywords('100%', 'none', 'auto'), '-ms-text-size-adjust': keywords('100%', 'none', 'auto'),
};
for (const side of ['', '-top', '-right', '-bottom', '-left']) {
  PROPERTIES[`margin${side}`] = each(t => t === 'auto' || within(t, 300), side ? 1 : 4);
  PROPERTIES[`padding${side}`] = each(t => within(t, 300), side ? 1 : 4);
  PROPERTIES[`border${side}`] = each(borderToken, 3);
  for (const part of ['width', 'style', 'color']) PROPERTIES[`border${side}-${part}`] = each(borderToken, side ? 1 : 4);
}
for (const p of ['width', 'min-width', 'max-width', 'height', 'min-height', 'max-height']) PROPERTIES[p] = v => v === 'auto' || v === 'none' || within(v, Infinity) ? v : undefined;

// ----- Style sheets, inlined -----------------------------------------------------------------------------------------

type Declaration = { property: string; value: string; important: boolean };
type Compound = { tag?: string; ids: string[]; classes: string[]; attributes: { name: string; op?: string; value?: string }[]; pseudo: { name: string; argument?: string }[]; not: Compound[] };
type Selector = { compounds: Compound[]; combinators: string[]; specificity: number };
type Rule = { selector: Selector; declarations: Declaration[]; order: number };
type Facts = { id: number; tag: string; attrs: Map<string, string>; classes: Set<string>; chain: Set<string>; parent: Facts | null; index: number; typeIndex: number; siblings: number; typeSiblings: number; previous: Facts | null };
const MAX_SHEET_BYTES = 256 * 1024, MAX_RULES = 4000, MAX_STEPS = 2_000_000;
const PSEUDO = new Set(['first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type']);
/** Comments removed, outside string literals. */
function stripComments(css: string) {
  let out = '', quote = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (quote) { out += c; if (c === '\\' && i + 1 < css.length) out += css[++i]; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '/' && css[i + 1] === '*') { const end = css.indexOf('*/', i + 2); i = end < 0 ? css.length : end + 1; out += ' '; continue; }
    out += c;
  }
  return out;
}
function declarations(body: string): Declaration[] {
  const out: Declaration[] = [];
  for (const item of body.split(';')) {
    const colon = item.indexOf(':');
    if (colon < 1) continue;
    const property = item.slice(0, colon).trim().toLowerCase(), important = /!\s*important\s*$/i.test(item), value = item.slice(colon + 1).replace(/!\s*important\s*$/i, '').trim();
    if (property && value) out.push({ property, value, important });
  }
  return out;
}
/** The qualified rules of a sheet in source order; at-rules (media, supports, font-face, import) are left out. */
function rules(sheet: string, out: Rule[]) {
  const css = sheet.replace(/@(?:import|charset|namespace|layer)\b(?:url\([^)]*\)|"[^"]*"|'[^']*'|[^;{])*;/gi, ' ');
  for (let i = 0; i < css.length && out.length < MAX_RULES;) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let level = 1, j = open + 1;
    for (; j < css.length && level; j++) { if (css[j] === '{') level++; else if (css[j] === '}') level--; }
    const body = css.slice(open + 1, level ? css.length : j - 1);
    i = j;
    if (!prelude || prelude.startsWith('@')) continue;
    const parsed = declarations(body);
    if (!parsed.length) continue;
    for (const { text } of selectorList(prelude)) {
      if (out.length >= MAX_RULES) break;
      const selector = parseSelector(text.replace(/\s+/g, ' ').trim());
      if (selector) out.push({ selector, declarations: parsed, order: out.length });
    }
  }
  return out;
}
/** One compound: type, classes, ids, attribute tests, structural pseudo-classes and :not(). Anything else makes the selector one this inliner never applies. */
function parseCompound(text: string): Compound | null {
  const compound: Compound = { ids: [], classes: [], attributes: [], pseudo: [], not: [] };
  let i = 0;
  const ident = () => { const m = /^[-\w\u00a0-\uffff]+/.exec(text.slice(i)); if (!m) return null; i += m[0].length; return m[0].toLowerCase(); };
  while (i < text.length) {
    const c = text[i]!;
    if (c === '*') i++;
    else if (c === '.') { i++; const name = ident(); if (!name) return null; compound.classes.push(name); }
    else if (c === '#') { i++; const name = ident(); if (!name) return null; compound.ids.push(name); }
    else if (c === '[') {
      const end = text.indexOf(']', i); if (end < 0) return null;
      const m = /^\s*([-\w]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\s*$/.exec(text.slice(i + 1, end)); if (!m) return null;
      compound.attributes.push({ name: m[1]!.toLowerCase(), op: m[2], value: m[3] ?? m[4] ?? m[5] });
      i = end + 1;
    }
    else if (c === ':') {
      if (text[i + 1] === ':') return null;
      i++; const name = ident(); if (!name) return null;
      let argument: string | undefined;
      if (text[i] === '(') { const end = text.indexOf(')', i); if (end < 0) return null; argument = text.slice(i + 1, end); i = end + 1; }
      if (name === 'not') { const inner = argument && parseCompound(argument.trim()); if (!inner) return null; compound.not.push(inner); continue; }
      if (!PSEUDO.has(name)) return null;
      compound.pseudo.push({ name, argument });
    }
    else if (/[-\w]/.test(c)) { const name = ident(); if (!name) return null; compound.tag = name; }
    else return null;
  }
  return compound;
}
function parseSelector(text: string): Selector | null {
  const tokens = text.match(/\[[^\]]*\]|\([^)]*\)|[>+~]|\s+|[^\s>+~[(]+/g) ?? [];
  const compounds: Compound[] = [], combinators: string[] = [];
  let buffer = '', pending: string | null = null;
  const flush = () => { if (!buffer) return true; const compound = parseCompound(buffer); buffer = ''; if (!compound) return false; if (compounds.length) combinators.push(pending ?? ' '); compounds.push(compound); pending = null; return true; };
  for (const token of tokens) {
    if (/^\s+$/.test(token)) { if (!flush()) return null; if (pending === null && compounds.length) pending = ' '; }
    else if (token === '>' || token === '+' || token === '~') { if (!flush()) return null; pending = token; }
    else buffer += token;
  }
  if (!flush() || !compounds.length || pending) return null;
  const weight = (c: Compound): number => c.ids.length * 10000 + (c.classes.length + c.attributes.length + c.pseudo.length) * 100 + (c.tag ? 1 : 0) + c.not.reduce((n, inner) => n + weight(inner), 0);
  return { compounds, combinators, specificity: compounds.reduce((n, c) => n + weight(c), 0) };
}
function nth(argument: string | undefined, position: number) {
  const a = (argument ?? '').replace(/\s+/g, '').toLowerCase();
  if (a === 'odd') return position % 2 === 1;
  if (a === 'even') return position % 2 === 0;
  const m = /^([+-]?\d*)n([+-]\d+)?$|^([+-]?\d+)$/.exec(a);
  if (!m) return false;
  if (m[3] !== undefined) return position === Number(m[3]);
  const step = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : Number(m[1]), offset = Number(m[2] ?? 0);
  if (step === 0) return position === offset;
  const k = (position - offset) / step;
  return Number.isInteger(k) && k >= 0;
}
function matchesCompound(facts: Facts, compound: Compound): boolean {
  if (compound.tag && compound.tag !== facts.tag) return false;
  for (const id of compound.ids) if (facts.attrs.get('id')?.toLowerCase() !== id) return false;
  for (const name of compound.classes) if (!facts.classes.has(name)) return false;
  for (const { name, op, value } of compound.attributes) {
    const actual = facts.attrs.get(name);
    if (actual === undefined) return false;
    if (op === undefined) continue;
    const expected = value ?? '';
    const ok = op === '=' ? actual === expected : op === '~=' ? actual.split(/\s+/).includes(expected) : op === '|=' ? actual === expected || actual.startsWith(expected + '-')
      : op === '^=' ? actual.startsWith(expected) : op === '$=' ? actual.endsWith(expected) : op === '*=' ? actual.includes(expected) : false;
    if (!ok) return false;
  }
  for (const inner of compound.not) if (matchesCompound(facts, inner)) return false;
  for (const { name, argument } of compound.pseudo) {
    switch (name) {
      case 'first-child': if (facts.index !== 1) return false; break;
      case 'last-child': if (facts.index !== facts.siblings) return false; break;
      case 'only-child': if (facts.siblings !== 1) return false; break;
      case 'first-of-type': if (facts.typeIndex !== 1) return false; break;
      case 'last-of-type': if (facts.typeIndex !== facts.typeSiblings) return false; break;
      case 'only-of-type': if (facts.typeSiblings !== 1) return false; break;
      case 'nth-child': if (!nth(argument, facts.index)) return false; break;
      case 'nth-last-child': if (!nth(argument, facts.siblings - facts.index + 1)) return false; break;
      case 'nth-of-type': if (!nth(argument, facts.typeIndex)) return false; break;
      case 'nth-last-of-type': if (!nth(argument, facts.typeSiblings - facts.typeIndex + 1)) return false; break;
    }
  }
  return true;
}
/** The sheets of a message as a function from an element to the declarations its rules give it, in cascade order
 *  (least to most authoritative), with the element's own style attribute last. Bounded by sheet size, rule count and
 *  matching steps; a message past the step budget is too large to screen. */
function inliner(sheets: string[], tree: Map<Element, Facts>) {
  const parsed: Rule[] = [];
  const text = sheets.join('\n');
  if (text.length <= MAX_SHEET_BYTES) rules(stripComments(text), parsed);
  // Indexed by the subject compound's first class, id or type, with the classes and ids a selector needs anywhere.
  const index = new Map<string, { rule: Rule; needs: string[] }[]>();
  for (const rule of parsed) {
    const last = rule.selector.compounds[rule.selector.compounds.length - 1]!;
    const key = last.classes.length ? `.${last.classes[0]}` : last.ids.length ? `#${last.ids[0]}` : last.tag ?? '*';
    const entry = { rule, needs: rule.selector.compounds.flatMap(c => [...c.classes.map(n => `.${n}`), ...c.ids.map(n => `#${n}`)]) };
    const list = index.get(key); if (list) list.push(entry); else index.set(key, [entry]);
  }
  let steps = 0;
  const walk = (selector: Selector, at: number, subject: Facts | null): boolean => {
    if (!subject) return false;
    if (++steps > MAX_STEPS) throw tooLarge();
    if (!matchesCompound(subject, selector.compounds[at]!)) return false;
    if (at === 0) return true;
    const combinator = selector.combinators[at - 1];
    if (combinator === '>') return walk(selector, at - 1, subject.parent);
    if (combinator === '+') return walk(selector, at - 1, subject.previous);
    if (combinator === '~') { for (let p = subject.previous; p; p = p.previous) if (walk(selector, at - 1, p)) return true; return false; }
    for (let p = subject.parent; p; p = p.parent) if (walk(selector, at - 1, p)) return true;
    return false;
  };
  // A declaration's place in the cascade: importance, then specificity (an inline style's above any rule's), then order.
  const rank = (d: Declaration, specificity: number, order: number) => (d.important ? 1e12 : 0) + specificity * 1e5 + order;
  return (element: Element): Declaration[] => {
    const facts = tree.get(element), inline = declarations(stripComments(element.attrs.find(a => a.name === 'style')?.value ?? ''));
    if (!facts || !parsed.length) return inline;
    const winners = new Map<string, { d: Declaration; rank: number }>();
    const offer = (d: Declaration, at: number) => { const current = winners.get(d.property); if (!current) winners.set(d.property, { d, rank: at }); else if (at >= current.rank) { current.d = d; current.rank = at; } };
    for (const key of subjectKeys(facts.tag, facts.attrs.get('id')?.toLowerCase(), facts.classes))
      for (const { rule, needs } of index.get(key) ?? []) {
        if (++steps > MAX_STEPS) throw tooLarge();
        if (needs.every(need => facts.chain.has(need)) && walk(rule.selector, rule.selector.compounds.length - 1, facts))
          for (const d of rule.declarations) offer(d, rank(d, rule.selector.specificity, rule.order));
      }
    inline.forEach((d, i) => offer(d, rank(d, 1e6, 1e9 + i)));
    return [...winners.values()].sort((a, b) => a.rank - b.rank).map(w => w.d);
  };
}
/** Element facts for selector matching, over the tree as submitted. */
function survey(root: Element): Map<Element, Facts> {
  const tree = new Map<Element, Facts>();
  let count = 0;
  const visit = (parent: Element, facts: Facts | null) => {
    const elements = parent.childNodes.filter((node): node is Element => isElement(node) && node.namespaceURI === HTML);
    const types = new Map<string, number>();
    let previous: Facts | null = null;
    for (const [i, element] of elements.entries()) {
      const attrs = new Map(element.attrs.map(a => [a.name, a.value])), classes = new Set((attrs.get('class') ?? '').toLowerCase().split(/\s+/).filter(Boolean));
      const chain = new Set(facts?.chain ?? []); for (const name of classes) chain.add(`.${name}`); const id = attrs.get('id'); if (id) chain.add(`#${id.toLowerCase()}`);
      const typeIndex = (types.get(element.tagName) ?? 0) + 1; types.set(element.tagName, typeIndex);
      const own: Facts = { id: ++count, tag: element.tagName, attrs, classes, chain, parent: facts, index: i + 1, typeIndex, siblings: elements.length, typeSiblings: 0, previous };
      tree.set(element, own); previous = own;
      visit(element, own);
    }
    for (const element of elements) tree.get(element)!.typeSiblings = types.get(element.tagName)!;
  };
  visit(root, null);
  return tree;
}

export type CssRule = { prelude: string; decls: [string, string][] };
/** Past the string literal that starts at i: its closing quote, the end of its line, or the end of the text. */
export function stringEnd(css: string, i: number) {
  for (let j = i + 1; j < css.length; j++) { if (css[j] === '\\') j++; else if (css[j] === css[i] || css[j] === '\n') return j + 1; }
  return css.length;
}
/** A declaration's name as a client reads it: escapes decoded, case folded except for a custom property's. */
const propertyName = (raw: string) => { const name = unescapeCss(raw.trim()); return name.startsWith('--') ? name : name.toLowerCase(); };
/** Every rule's selector and declarations, those inside at-rules included; root collects bare declarations (a style attribute's).
 *  An at-rule nested in a style rule (CSS nesting: img { @media all { width: 2000px } }) applies to that rule's
 *  selectors, and so takes them as its prelude, as does a nested style rule's own; @scope's bare declarations apply to
 *  any element it scopes (*). */
export function cssRules(css: string): CssRule[] {
  const root: CssRule = { prelude: '', decls: [] }, rules = [root], stack = [root];
  let buffer = '', parens = 0;
  const under = (prelude: string, parent: string) => !prelude.startsWith('@') ? prelude : parent && !parent.startsWith('@') ? parent : /^@scope\b/i.test(unescapeCss(prelude)) ? '*' : prelude;
  const flush = () => { const text = buffer.trim(), colon = text.indexOf(':'); buffer = ''; if (colon > 0 && !text.startsWith('@')) stack.at(-1)!.decls.push([propertyName(text.slice(0, colon)), text.slice(colon + 1).trim()]); };
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c === '"' || c === "'") { const end = stringEnd(css, i); buffer += css.slice(i, end); i = end - 1; }
    else if (c === '\\') { buffer += css.slice(i, i + 2); i++; }
    else if (c === '/' && css[i + 1] === '*') { const end = css.indexOf('*/', i + 2); i = end < 0 ? css.length : end + 1; buffer += ' '; }
    else if (c === '(' || (c === ')' && parens)) { parens += c === '(' ? 1 : -1; buffer += c; }
    else if (parens) buffer += c;
    else if (c === '{') { const rule: CssRule = { prelude: under(buffer.trim(), stack.at(-1)!.prelude), decls: [] }; buffer = ''; rules.push(rule); stack.push(rule); }
    else if (c === '}') { flush(); if (stack.length > 1) stack.pop(); }
    else if (c === ';') flush();
    else buffer += c;
  }
  flush();
  return rules;
}
/** A selector list's selectors, split at its top-level commas: each as written, and bare, without its strings, escapes'
 *  characters and bracketed [...] and (...) groups however nested (an escape itself stays, for subjectOf). */
export function selectorList(prelude: string) {
  const out: { text: string; bare: string }[] = [];
  let start = 0, depth = 0, bare = '';
  for (let i = 0; i < prelude.length; i++) {
    const c = prelude[i]!;
    if (c === '\\') { if (!depth) bare += prelude.slice(i, i + 2); i++; }
    else if (c === '"' || c === "'") i = stringEnd(prelude, i) - 1;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth = Math.max(0, depth - 1);
    else if (depth) continue;
    else if (c === ',') { out.push({ text: prelude.slice(start, i), bare }); start = i + 1; bare = ''; }
    else bare += c;
  }
  out.push({ text: prelude.slice(start), bare });
  return out;
}
/** The index keys an element's rules may be filed under: any element's, its type's, its id's and each class's. */
const subjectKeys = (tag: string, id: string | undefined, classes: Set<string>) => ['*', tag, ...id ? [`#${id}`] : [], ...[...classes].map(c => `.${c}`)];
/** What a bare selector's subject (its last compound; selectorList) needs of an element: a type, classes and ids. One
 *  with an escape or a namespace could name anything, so it needs nothing. */
type Subject = { tag?: string; classes: string[]; ids: string[] };
function subjectOf(bare: string): Subject {
  const subject = bare.trim().split(/[\s>+~]+/).at(-1)!.toLowerCase();
  if (/[\\|]/.test(subject)) return { classes: [], ids: [] };
  return { tag: /^[a-z][\w-]*/.exec(subject)?.[0], classes: [...subject.matchAll(/\.([-\w]+)/g)].map(m => m[1]!), ids: [...subject.matchAll(/#([-\w]+)/g)].map(m => m[1]!) };
}
/**
 * Bare selectors (selectorList) by the subject they could select, for a reader that asks of each element which rules may apply to it
 * without running a selector engine: filed under the subject's first class, id or type, so an element meets only the
 * ones it could match. At most MAX_RULES selectors (add answers false past them), and `step` is called per comparison,
 * for the caller's work budget.
 */
export function selectorSubjects<T>() {
  const index = new Map<string, { subject: Subject; value: T }[]>();
  let size = 0;
  return {
    add(bare: string, value: T) {
      if (++size > MAX_RULES) return false;
      const subject = subjectOf(bare), key = subject.classes.length ? `.${subject.classes[0]}` : subject.ids.length ? `#${subject.ids[0]}` : subject.tag ?? '*';
      const list = index.get(key); if (list) list.push({ subject, value }); else index.set(key, [{ subject, value }]);
      return true;
    },
    /** The values of the selectors whose subject the element meets. */
    *matching(element: { tag: string; classes: Set<string>; id?: string }, step: () => void) {
      for (const key of subjectKeys(element.tag, element.id, element.classes))
        for (const { subject, value } of index.get(key) ?? []) {
          step();
          if ((!subject.tag || subject.tag === element.tag) && subject.classes.every(c => element.classes.has(c)) && subject.ids.every(i => i === element.id)) yield value;
        }
    },
  };
}

// ----- Elements and attributes -------------------------------------------------------------------------------------

/** Elements that stay, with the attributes they keep besides style, dir and lang. Any other element is unwrapped, its
 *  text staying in the flow, except those a client never shows as text, which go with their content. */
const KEPT: Record<string, string[]> = {
  a: ['href'], abbr: [], address: [], article: [], aside: [], b: [], bdi: [], big: [], blockquote: [], br: [], caption: ['align'], center: [], cite: [], code: [],
  col: ['span', 'width', 'align', 'valign'], colgroup: ['span', 'width', 'align', 'valign'], dd: [], del: [], dfn: [], div: ['align'], dl: [], dt: [], em: [], figcaption: [], figure: [],
  font: ['color', 'face', 'size'], footer: [], h1: ['align'], h2: ['align'], h3: ['align'], h4: ['align'], h5: ['align'], h6: ['align'], header: [], hr: ['align', 'width', 'size', 'noshade'], i: [],
  img: ['src', 'alt', 'width', 'height', 'border', 'align', 'hspace', 'vspace'], ins: [], kbd: [], li: [], main: [], mark: [], nav: [], ol: [], p: ['align'], pre: [], q: [], s: [],
  samp: [], section: [], small: [], span: [], strike: [], strong: [], sub: [], sup: [], table: ['role', 'width', 'height', 'align', 'bgcolor', 'border', 'cellpadding', 'cellspacing'],
  tbody: ['align', 'valign'], td: ['width', 'height', 'align', 'valign', 'bgcolor', 'colspan', 'rowspan', 'nowrap'], tfoot: ['align', 'valign'], th: ['width', 'height', 'align', 'valign', 'bgcolor', 'colspan', 'rowspan', 'nowrap'],
  thead: ['align', 'valign'], time: [], tr: ['align', 'valign', 'bgcolor', 'height'], tt: [], u: [], ul: [], var: [], wbr: [],
};
const DROPPED = new Set(['script', 'style', 'template', 'noscript', 'noembed', 'noframes', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'title', 'xml', 'canvas', 'audio', 'video', 'source', 'track', 'map', 'area',
  'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'datalist', 'output', 'progress', 'meter', 'dialog', 'slot']);
const digits = (v: string) => /^\d{1,4}$/.test(v) ? v : undefined;
const ATTRIBUTES: Record<string, (value: string) => string | undefined> = {
  href: v => /^(?:https?:|mailto:|tel:)/i.test(v.trim()) ? v.trim() : undefined, src: v => /^(?:https?:|cid:|data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$)/i.test(v.trim()) ? v.trim() : undefined, alt: v => screenedText(v),
  lang: v => /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(v) ? v : undefined, role: keywords('presentation', 'none'),
  align: keywords('left', 'center', 'right', 'justify', 'top', 'middle', 'bottom'), valign: keywords('top', 'middle', 'bottom', 'baseline'),
  width: v => /^\d{1,4}%?$/.test(v) ? v : undefined, height: v => /^\d{1,4}%?$/.test(v) ? v : undefined, border: digits, cellpadding: digits, cellspacing: digits, colspan: digits, rowspan: digits, span: digits,
  start: digits, value: digits, hspace: v => digits(v) && Number(v) <= 300 ? v : undefined, vspace: v => digits(v) && Number(v) <= 300 ? v : undefined, size: v => /^[1-7]$/.test(v) ? v : undefined,
  bgcolor: v => colorOf(v) ? v : undefined, color: v => colorOf(v) ? v : undefined, face: family, type: keywords('1', 'a', 'A', 'i', 'I', 'disc', 'circle', 'square'), nowrap: () => '', noshade: () => '',
};
const META = { charset: () => 'utf-8', name: keywords('viewport', 'color-scheme', 'supported-color-schemes', 'x-apple-disable-message-reformatting', 'format-detection'), 'http-equiv': keywords('content-type', 'x-ua-compatible'), content: (v: string) => /^[\w\s,;=:./-]{0,200}$/.test(v) ? v : undefined };
const FONT_SIZE_ATTRIBUTE: Record<string, number> = { 1: 10, 2: 13, 3: 16, 4: 18, 5: 24, 6: 32, 7: 48 };
const UA_SCALE: Record<string, number> = { small: 1 / 1.2, sub: 1 / 1.2, sup: 1 / 1.2, big: 1.2, h5: 0.83, h6: 0.67 };
const PREHEADER_STYLE = 'display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all';
const hides = (style: string) => /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?|max-height\s*:\s*0(?:px)?|font-size\s*:\s*[01](?:\.\d+)?(?:px|pt)?)\s*(?:;|$)/i.test(style);

const lengthOf = (v: string | undefined) => v === undefined ? undefined : /%$/.test(v) ? Math.round(parseFloat(v) * 6) : /^\d+$/.test(v) ? Number(v) : px(v);
/** The area a client draws a picture at: per side the larger of the attribute and the style, full width when neither is declared. */
function drawnArea(attribute: (name: string) => string | undefined, style: (name: string) => string | undefined) {
  const side = (name: 'width' | 'height') => { const sizes = [lengthOf(style(name)), lengthOf(attribute(name))].filter((n): n is number => n !== undefined); return sizes.length ? Math.max(...sizes) : undefined; };
  const width = side('width'), height = side('height');
  return (width ?? 600) * (height ?? (width === undefined ? 400 : Math.round(width * 2 / 3)));
}
// Properties that can change the size a client draws a picture at.
const SIZING = new Set(['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'zoom', 'inline-size', 'block-size', 'min-inline-size', 'min-block-size',
  'max-inline-size', 'max-block-size', 'aspect-ratio', 'transform', 'scale', 'all']);
const WIDTHS = new Set(['width', 'min-width', 'inline-size', 'min-inline-size']), HEIGHTS = new Set(['height', 'min-height', 'block-size', 'min-block-size']);
type Sizes = { width: number; height: number; zoom: number };
/** `into` enlarged to the widest width, tallest height and largest zoom the declarations set. */
function enlarge(into: Sizes, decls: Declaration[]) {
  for (const d of decls) {
    const v = d.value.toLowerCase();
    if (d.property === 'zoom') { const n = /%$/.test(v) ? parseFloat(v) / 100 : parseFloat(v); if (Number.isFinite(n)) into.zoom = Math.max(into.zoom, n); continue; }
    const n = lengthOf(v);
    if (n === undefined || !(n > 0)) continue;
    if (WIDTHS.has(d.property)) into.width = Math.max(into.width, n); else if (HEIGHTS.has(d.property)) into.height = Math.max(into.height, n);
  }
  return into;
}
/** Every style sheet rule that sets a size property, rules inside at-rules (media queries) and nested ones included
 *  (cssRules), by the subject it could select (selectorSubjects), with the sizes it sets. A sheet past the size or rule
 *  budget is refused: it cannot be read for which pictures it resizes. */
function sizingRules(sheets: string[]) {
  const css = stripComments(sheets.join('\n'));
  if (css.length > MAX_SHEET_BYTES) throw tooLarge();
  const index = selectorSubjects<Sizes>();
  for (const rule of cssRules(css)) {
    const decls = rule.decls.filter(([property]) => SIZING.has(property)).map(([property, value]) => ({ property, value: unescapeCss(value).replace(/!\s*important\s*$/i, '').trim(), important: false }));
    if (!decls.length || !rule.prelude || rule.prelude.startsWith('@')) continue;
    const sizes = enlarge({ width: 0, height: 0, zoom: 1 }, decls);
    for (const { bare } of selectorList(rule.prelude)) if (!index.add(bare, sizes)) throw tooLarge();
  }
  return index;
}
/** A data: URL a style loads as an SVG picture, whose text no screen reads: refused in markup delivered as written, in
 *  any style sheet or style attribute, comments and escapes read either way. */
const SVG_DATA = /data\s*:\s*image\s*\/\s*svg/i;
function refuseSvgData(parent: Parent) {
  for (const node of parent.childNodes) {
    if (!isElement(node)) { if ('childNodes' in node) refuseSvgData(node as unknown as Parent); continue; }
    const css = [node.tagName === 'style' ? node.childNodes.map(child => isText(child) ? child.value : '').join('') : '', node.attrs.find(a => a.name === 'style')?.value ?? ''];
    if (css.some(text => text && [text, stripComments(text)].some(v => SVG_DATA.test(unescapeCss(v)))))
      throw new ApiError(422, 'ATTACHMENT_TYPE_UNSCREENABLE', `Hosted sending cannot screen an SVG image a style draws (a data:image/svg+xml URL): SVG images are never sent. Use a PNG or JPEG.`);
    refuseSvgData(node);
  }
}
/** The elements that draw a picture: images, inline SVG, image inputs and Office VML with a source. */
const isPicture = (element: Element) => { const tag = element.tagName; return tag === 'img' || tag === 'image' || tag === 'svg' || (tag === 'input' && element.attrs.find(a => a.name === 'type')?.value.toLowerCase() === 'image') || (/:(?:imagedata|image|fill)$/.test(tag) && element.attrs.some(a => a.name === 'src')); };
type State = { fontPx: number; color: Rgb; background: Rgb };
export function screenedHtml(html: string, previewText?: string): string {
  let copy = pass(html, previewText);
  // Misnested formatting elements can make a parser read the serialized tree back differently; the copy is read again
  // until it reads as itself, so a client parses exactly what was screened.
  for (let i = 0; i < 2; i++) { const again = pass(copy, previewText); if (again === copy) break; copy = again; }
  return copy;
}
/** What the probation pass read of an HTML body, for the support lint (src/deliverability.ts). */
export type HtmlStats = { words: number; imageArea: number; images: number; hiddenWords: number; recoloredWords: number };
/**
 * The probation pass's own reading of an HTML body, without refusing it: visible words, images by the area a client
 * draws them at, words hidden by markup (not displayed, invisible, zero-sized) and words drawn in their background
 * color, and how many more words the image rule (a 200 x 200 picture free, 25 words per further 600 x 300) asks for.
 */
/** A probation message as it is delivered and screened: every textual field without the bidi controls that reorder it,
 *  the markup reduced to what a client shows as text, the campaign preheader added back from its own field. */
export function probationCopy<T extends { subject: string; text?: string; fromName?: string; previewText?: string; html?: string }>(s: T): T {
  let copy = s;
  for (const key of ['subject', 'text', 'fromName', 'previewText'] as const) { const value = copy[key]; if (value !== undefined) copy = { ...copy, [key]: screenedText(value) }; }
  return copy.html ? { ...copy, html: screenedHtml(copy.html, copy.previewText) } : copy;
}
/**
 * The image rule for a message delivered as written (a sender off probation): the words the light desktop reading
 * shows, against every picture the markup can draw in some client, which the probation copy would have left out:
 * images however hidden or dropped, inside conditional comments and inline SVG, backgrounds, and images style sheets draw.
 */
export function assertKeptImages(html: string) {
  const stats: HtmlStats = { words: 0, imageArea: 0, images: 0, hiddenWords: 0, recoloredWords: 0 };
  pass(html, undefined, stats, true);
  if (stats.imageArea > IMAGE_FREE_PIXELS + stats.words * IMAGE_PIXELS_PER_WORD) throw imageOnly();
}
/** A Hosted message as it is delivered: on probation the copy the screen read, otherwise as written under the image rule. */
export function hostedCopy<T extends { subject: string; text?: string; fromName?: string; previewText?: string; html?: string }>(s: T, probation: boolean): T {
  if (probation) return probationCopy(s);
  if (s.html) assertKeptImages(s.html);
  return s;
}
export function screenedHtmlStats(html: string) {
  const stats: HtmlStats = { words: 0, imageArea: 0, images: 0, hiddenWords: 0, recoloredWords: 0 };
  pass(html, undefined, stats);
  const required = Math.max(0, Math.ceil((stats.imageArea - IMAGE_FREE_PIXELS) / IMAGE_PIXELS_PER_WORD));
  return { ...stats, wordsRequiredByImages: required, imageRulePasses: stats.words >= required };
}
// `kept`: the markup is delivered as written (assertKeptImages), so the pictures this reading leaves out still count.
function pass(html: string, previewText?: string, stats?: HtmlStats, kept = false): string {
  if (html.length > 512 * 1024) throw tooLarge();
  const document = boundedHtmlFragment(html, 'document', { clients: kept });
  if (!document) throw tooLarge();
  const root = document.childNodes.find((node): node is Element => isElement(node) && node.tagName === 'html')!;
  const part = (tag: 'head' | 'body') => {
    let found = root.childNodes.find((node): node is Element => isElement(node) && node.tagName === tag);
    // A frameset document has no body; the copy gets an empty one.
    if (!found) { found = defaultTreeAdapter.createElement(tag, HTML, []); defaultTreeAdapter.appendChild(root, found); }
    return found;
  };
  const head = part('head'), body = part('body');
  if (kept) refuseSvgData(root);
  const sheets: string[] = [];
  const collect = (parent: Parent) => { for (const node of parent.childNodes) if (isElement(node) && node.namespaceURI === HTML) { if (node.tagName === 'style') sheets.push(node.childNodes.map(child => isText(child) ? child.value : '').join('')); else collect(node); } else if (!isElement(node) && 'childNodes' in node) collect(node as unknown as Parent); };
  collect(root);
  const styles = inliner(sheets, survey(root));
  let seenText = false, words = 0, imageArea = 0;
  // Kept markup: an element's own background image, and every picture under a node this reading leaves out.
  const attribute = (element: Element, name: string) => element.attrs.find(a => a.name === name)?.value;
  // Kept markup: a picture whose size delivered CSS could change (its own style, or a sheet rule, media queries included,
  // that could select it) counts at full size: at least a full-width 600 x 400, more if the CSS or attributes declare
  // more, times any zoom. Only a picture with no such CSS keeps the size it declares (drawnArea).
  const sizing = kept ? sizingRules(sheets) : null;
  let sizingSteps = 0;
  const step = () => { if (++sizingSteps > MAX_STEPS) throw tooLarge(); };
  const fullSize = (element: Element): number | undefined => {
    if (!kept) return undefined;
    const own = declarations(stripComments(unescapeCss(attribute(element, 'style') ?? ''))).filter(d => SIZING.has(d.property));
    const size = enlarge({ width: 600, height: 400, zoom: 1 }, own);
    let matched = own.length > 0 || !sizing;
    if (sizing) {
      const classes = new Set((attribute(element, 'class') ?? '').toLowerCase().split(/\s+/)), id = attribute(element, 'id')?.toLowerCase();
      for (const rule of sizing.matching({ tag: element.tagName, classes, id }, step)) {
        matched = true;
        size.width = Math.max(size.width, rule.width); size.height = Math.max(size.height, rule.height); size.zoom = Math.max(size.zoom, rule.zoom);
      }
    }
    if (!matched) return undefined;
    const declared = (name: string) => lengthOf(attribute(element, name)) || 0;
    return Math.max(size.width, declared('width')) * Math.max(size.height, declared('height')) * size.zoom * size.zoom;
  };
  const background = (element: Element) => {
    if (!kept) return 0;
    const own = new Map(declarations(stripComments(unescapeCss(attribute(element, 'style') ?? ''))).map(d => [d.property, d.value.toLowerCase()]));
    const drawn = attribute(element, 'background')?.trim() || ['background', 'background-image'].some(p => /(?:url|image-set)\(/.test(own.get(p) ?? ''));
    return drawn ? drawnArea(name => attribute(element, name), name => own.get(name)) : 0;
  };
  const pictures = (node: Node | Parent): number => {
    if (!kept) return 0;
    let area = 0;
    if ('tagName' in node) {
      const element = node as Element, tag = element.tagName, own = new Map(declarations(stripComments(attribute(element, 'style') ?? '')).map(d => [d.property, d.value.toLowerCase()]));
      if (tag === 'script' || tag === 'style' || tag === 'template') return 0;
      area += background(element);
      if (isPicture(element)) area += fullSize(element) ?? drawnArea(name => attribute(element, name), name => own.get(name));
      if (tag === 'svg') return area;
    }
    if ('childNodes' in node) for (const child of node.childNodes) area += pictures(child);
    return area;
  };
  // Pictures style sheets draw, at full width each: a client may apply any of their rules.
  if (kept) for (const sheet of sheets) {
    const css = unescapeCss(stripComments(sheet)).replace(/@import[^;]*;?/gi, ' ').replace(/@font-face\s*{[^}]*}/gi, ' ');
    imageArea += (css.match(/\b(?:url|image-set)\(/gi)?.length ?? 0) * 600 * 400;
  }
  const wordsIn = (node: Node): number => isText(node) ? visibleWords(node.value) : isElement(node) ? node.childNodes.reduce((n, child) => n + wordsIn(child), 0) : 0;
  const detach = (node: Node) => defaultTreeAdapter.detachNode(node);
  const attributes = (element: Element, allowed: Record<string, (value: string) => string | undefined>) => {
    element.attrs = element.attrs.flatMap(a => { const value = own(allowed, a.name)?.(a.value); return value === undefined ? [] : [{ name: a.name, value }]; });
  };
  /** The declarations a client may apply from the element's merged style, and the state its text inherits. */
  const styled = (element: Element, inherited: State, merged: Declaration[]) => {
    const state = { ...inherited }, kept = new Map<string, string>();
    const bgcolor = element.attrs.find(a => a.name === 'bgcolor')?.value, fontColor = element.tagName === 'font' ? element.attrs.find(a => a.name === 'color')?.value : undefined;
    const fontSize = element.tagName === 'font' ? own(FONT_SIZE_ATTRIBUTE, element.attrs.find(a => a.name === 'size')?.value ?? '') : undefined;
    const paint = (token: string) => { const c = colorOf(token); if (c) state.background = blend(c.rgb, c.alpha, state.background); };
    if (bgcolor) paint(bgcolor);
    if (fontColor) { const c = colorOf(fontColor)!; state.color = blend(c.rgb, c.alpha, state.background); }
    if (fontSize) state.fontPx = fontSize;
    const scale = own(UA_SCALE, element.tagName);
    if (scale) state.fontPx *= scale;
    for (const { property, value: raw } of merged) {
      // One space between tokens, none inside parentheses; a value with anything but rgb()/rgba() in parentheses, an
      // escape or a comment is not one this reader applies.
      const value = raw.toLowerCase().replace(/\s*\(\s*([^)]*?)\s*\)/g, (_, inner: string) => `(${inner.replace(/\s*,\s*/g, ',').replace(/\s+/g, ',')})`).replace(/\s+/g, ' ');
      if (!value || /\\|\/\*|[{}]/.test(value)) continue;
      // A background keeps its color and loses its image.
      if (property === 'background-color' || property === 'background') {
        const color = value.split(' ').find(token => colorOf(token));
        if (!color) continue;
        paint(color); kept.set('background-color', color);
      }
      else if (/(?<!rgba?)\(/.test(value)) continue;
      else if (property === 'color') { const c = colorOf(value); if (!c) continue; state.color = blend(c.rgb, c.alpha, state.background); kept.set(property, value); }
      else if (property === 'font-size') { const size = fontPx(value, state.fontPx); if (size === undefined || size < MIN_FONT_PX) continue; state.fontPx = size; kept.set(property, value); }
      else if (property === 'font') {
        const m = /^(?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]00) )*([\w.%-]+)(?:\/([\w.%]+))? ([\w\s,'"-]+)$/.exec(value);
        const size = m ? fontPx(m[1]!, state.fontPx) : undefined;
        if (!m || size === undefined || size < MIN_FONT_PX || (m[2] && !lineHeight(m[2])) || !family(m[3]!)) continue;
        state.fontPx = size; kept.set(property, value);
      }
      else { const checked = own(PROPERTIES, property)?.(value); if (checked !== undefined) kept.set(property, checked); }
    }
    if (state.fontPx < MIN_FONT_PX) { state.fontPx = MIN_FONT_PX; kept.set('font-size', `${MIN_FONT_PX}px`); }
    return { state, kept, style: [...kept].map(([property, value]) => `${property}:${value}`).join(';') };
  };
  const clean = (parent: Parent, inherited: State) => {
    for (let i = 0; i < parent.childNodes.length;) {
      const node = parent.childNodes[i]!;
      if (isText(node)) {
        node.value = screenedText(node.value);
        if (node.value.trim()) {
          seenText = true; words += wordsIn(node);
          // Text drawn in its background color is recolored so it reads as the screen read it.
          if (contrast(inherited.color, inherited.background) < READABLE) {
            if (stats) stats.recoloredWords += wordsIn(node);
            const ink = contrast([0, 0, 0], inherited.background) >= contrast([255, 255, 255], inherited.background) ? '#000000' : '#ffffff';
            const span = defaultTreeAdapter.createElement('span', HTML, [{ name: 'style', value: `color:${ink}` }]);
            defaultTreeAdapter.insertBefore(parent, span, node); detach(node); defaultTreeAdapter.appendChild(span, node);
          }
        }
        i++; continue;
      }
      if (!isElement(node) || node.namespaceURI !== HTML || DROPPED.has(node.tagName) || node.attrs.some(a => a.name === 'data-bane-preview' || a.name === 'data-opensend-preview')) { imageArea += pictures(node); detach(node); continue; }
      const merged = styles(node), style = merged.map(d => `${d.property}:${d.value}`).join(';'), full = isPicture(node) ? fullSize(node) : undefined;
      const text = node.childNodes.every(isText) ? node.childNodes.map(child => (child as DefaultTreeAdapterMap['textNode']).value).join('') : undefined;
      if (!seenText && (node.tagName === 'div' || node.tagName === 'p') && hides(style) && text?.trim() && text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim().length <= 300) {
        node.attrs = [{ name: 'style', value: PREHEADER_STYLE }];
        for (const child of node.childNodes) if (isText(child)) child.value = screenedText(child.value);
        seenText = true; i++; continue;
      }
      // Not displayed in the light scheme: left out with its content, as a client would.
      if (node.attrs.some(a => a.name === 'hidden') || merged.find(d => d.property === 'display')?.value.trim().toLowerCase() === 'none') { if (stats) stats.hiddenWords += wordsIn(node); imageArea += pictures(node); detach(node); continue; }
      if (stats && hides(style)) stats.hiddenWords += wordsIn(node);
      imageArea += background(node);
      const allowed = own(KEPT, node.tagName);
      if (!allowed) {
        // Unwrap: the children take the element's place and are read in turn.
        for (const child of node.childNodes.slice()) { detach(child); defaultTreeAdapter.insertBefore(parent, child, node); }
        detach(node); continue;
      }
      attributes(node, Object.fromEntries([...allowed, 'lang'].map(name => [name, ATTRIBUTES[name]!])));
      const { state, kept: declared } = styled(node, inherited, merged);
      node.attrs = node.attrs.filter(a => a.name !== 'style');
      if (node.tagName === 'img') {
        // The size a client draws it at: the larger of the attribute and the style (a minimum could only enlarge it,
        // so none is kept), a full-width picture when neither is declared.
        for (const property of ['min-width', 'min-height']) declared.delete(property);
        imageArea += full ?? drawnArea(name => node.attrs.find(a => a.name === name)?.value, name => declared.get(name));
        if (stats) stats.images++;
      }
      const applied = [...declared].map(([property, value]) => `${property}:${value}`).join(';');
      if (applied) node.attrs.push({ name: 'style', value: applied });
      clean(node, state);
      // A list item without text would draw a marker the screen never read.
      if (node.tagName === 'li' && !wordsIn(node)) { detach(node); continue; }
      i++;
    }
  };
  for (const node of document.childNodes.slice()) if (node !== root) detach(node);
  attributes(root, { lang: ATTRIBUTES.lang! });
  for (const node of root.childNodes.slice()) if (node !== head && node !== body) detach(node);
  for (const node of head.childNodes.slice()) {
    if (!isElement(node) || node.tagName !== 'meta') { detach(node); continue; }
    attributes(node, META);
    if (!node.attrs.length || (node.attrs.length === 1 && node.attrs[0]!.name === 'content')) detach(node);
  }
  if (!head.childNodes.some(node => isElement(node) && node.attrs.some(a => a.name === 'charset'))) {
    const charset = defaultTreeAdapter.createElement('meta', HTML, [{ name: 'charset', value: 'utf-8' }]);
    if (head.childNodes.length) defaultTreeAdapter.insertBefore(head, charset, head.childNodes[0]!); else defaultTreeAdapter.appendChild(head, charset);
  }
  const merged = styles(body);
  imageArea += background(body);
  attributes(body, { bgcolor: ATTRIBUTES.bgcolor!, lang: ATTRIBUTES.lang! });
  const { state, style } = styled(body, { fontPx: 16, color: [0, 0, 0], background: [255, 255, 255] }, merged);
  if (style) body.attrs.push({ name: 'style', value: style });
  clean(body, state);
  if (stats) Object.assign(stats, { words, imageArea });
  else if (imageArea > IMAGE_FREE_PIXELS + words * IMAGE_PIXELS_PER_WORD) throw imageOnly();
  if (previewText) {
    const preheader = defaultTreeAdapter.createElement('div', HTML, [{ name: 'data-bane-preview', value: 'true' }, { name: 'data-skip-in-text', value: 'true' }, { name: 'style', value: PREHEADER_STYLE }]);
    defaultTreeAdapter.appendChild(preheader, defaultTreeAdapter.createTextNode(previewText));
    if (body.childNodes.length) defaultTreeAdapter.insertBefore(body, preheader, body.childNodes[0]!); else defaultTreeAdapter.appendChild(body, preheader);
  }
  return '<!DOCTYPE html>' + serializeOuter(root);
}
