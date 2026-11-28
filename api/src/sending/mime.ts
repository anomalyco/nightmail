import { and, inArray, asc } from 'drizzle-orm';
import { Buffer } from 'node:buffer';
import type { DefaultTreeAdapterMap } from 'parse5';
import { id } from '../core/http.js';
import type { AttachmentTypes, Runtime, Actor, DbExecutor, Ctx, Storage } from '../core/types.js';
import type { Attachment } from '@aws-sdk/client-sesv2';
import { ApiError, ModuleLoadError } from '../core/errors.js';
import { uploadReservation } from '../upload-reservation.js';
import { uploadKey } from '../storage-keys.js';
import { attachments, attachmentLinks, type EmailSnapshot } from '../db/sending.js';
import { metadataInvalid, quoted, sizeText, mib, decodedDisplayName, fileTooLarge, MAX_ATTACHMENT_BYTES, type AttachmentMetadataInput, validateAttachment, AttachmentMetadata, invalidMetadataFields } from '../outbound-content.js';
import { idempotent } from '../idempotency.js';
import { type Admitted, type Refused, duplicateAttachment } from '../admission.js';
import { SEND_LIMITS, estimatedMimeBytes } from '../send-limits.js';
import { registerMemoryCache, fitMemoryCaches } from '../isolate-memory.js';
import { isBuiltinHost } from '../builtin-domain.js';
import { ATTACHMENT_LIMITS_TEXT } from '../attachment-limits.js';
import { scope, scopedAttachment, Address, FromName, type HtmlParser, CAMPAIGN_RENDERER_VERSION, loadParse5, MAX_BODY, loadBoundedHtml, keyed, AttachmentInfo } from './schemas.js';
import type { Outgoing } from './front-door.js';

export type AttachmentFacts = Pick<typeof attachments.$inferSelect, 'id' | 'size' | 'contentId'> & Partial<Pick<typeof attachments.$inferSelect, 'filename' | 'contentType'>>;
/** What Amazon SES refuses in an attachment's content ID and MIME type, by field. */
function sesProblems(metadata: { contentId?: string | null; contentType?: string | null }) {
  const max = SEND_LIMITS.mimeFieldChars, out: Partial<Record<'contentId' | 'contentType', string>> = {};
  if ((metadata.contentId?.length ?? 0) > max) out.contentId = `is ${metadata.contentId!.length} characters, and Amazon SES takes at most ${max}`;
  if (metadata.contentType && metadata.contentType.length > max) out.contentType = `is ${metadata.contentType.length} characters, and Amazon SES takes at most ${max}`;
  else if (metadata.contentType && /[^ -~]/.test(metadata.contentType)) out.contentType = 'has characters outside printable ASCII, which Amazon SES refuses';
  return out;
}
function sesAttachment(metadata: { filename?: string; contentId?: string | null; contentType?: string }) {
  const problems = sesProblems(metadata), fields = Object.keys(problems) as (keyof typeof problems)[];
  if (fields.length) throw metadataInvalid(metadata, fields, false, problems);
}
export type AttachmentProblem = { index: number; attachment?: number; id?: string; filename?: string; code: string; status: number; message: string; types?: AttachmentTypes; mailApp?: boolean };
/**
 * Every problem with the attachments of each email in a send, email by email and file by file, so a caller learns every
 * rule it broke in one try (a production agent found them one refusal at a time): a file missing or listed twice, a
 * content ID or type SES refuses, a content ID two files share, and files that together pass an email's limit, each
 * with its size.
 */
function attachmentProblems(lists: string[][], byId: Map<string, AttachmentFacts>): AttachmentProblem[] {
  const problems: AttachmentProblem[] = [];
  for (const [index, list] of lists.entries()) {
    const seen = new Map<string, number>(), cids = new Map<string, number>(), found: { k: number; row: AttachmentFacts }[] = [];
    for (const [k, id] of list.entries()) {
      const row = byId.get(id), at = { index, attachment: k, id, ...(row?.filename ? { filename: row.filename } : {}) }, name = row?.filename ? quoted(row.filename) : id;
      if (seen.has(id)) { problems.push({ ...at, code: 'DUPLICATE_ATTACHMENT', status: 422, message: `${name} is the same file as attachments.${seen.get(id)}: list each file once` }); continue; }
      seen.set(id, k);
      if (!row) { problems.push({ ...at, code: 'ATTACHMENT_NOT_FOUND', status: 404, message: `${id} was not found in this workspace: upload the file (POST /v1/attachments, or /v1/attachments/upload for raw bytes) and list the id it returns` }); continue; }
      found.push({ k, row });
      for (const [field, why] of Object.entries(sesProblems(row))) problems.push({ ...at, code: 'ATTACHMENT_METADATA_INVALID', status: 422, message: `${name}'s ${field} ${why}` });
      if (row.contentId) {
        const other = cids.get(row.contentId);
        if (other === undefined) cids.set(row.contentId, k);
        else problems.push({ ...at, code: 'DUPLICATE_CONTENT_ID', status: 422, message: `${name} has contentId ${quoted(row.contentId)}, as attachments.${other} does: each inline file needs its own` });
      }
    }
    const total = found.reduce((n, f) => n + f.row.size, 0);
    if (total > SEND_LIMITS.attachmentBytes) problems.push({ index, code: 'ATTACHMENT_LIMIT_EXCEEDED', status: 413,
      message: `the files are ${sizeText(total)} together, decoded (${found.map(f => `attachments.${f.k}${f.row.filename ? ` ${quoted(f.row.filename)}` : ''} ${sizeText(f.row.size)}`).join(', ')}), and one email carries at most ${mib(SEND_LIMITS.attachmentBytes)}: send fewer or smaller files, split them across emails, or link to large files from the email` });
  }
  return problems;
}
/** One refusal naming every problem: the first one's status, code, field and types, and each in the message and
 *  error.details. A mail app's message is the SMTP reply its user reads (gateway remote.rs): plain words naming each
 *  file once, the same in every part of a large envelope. */
export function attachmentRefusal(problems: AttachmentProblem[], batch: boolean) {
  const path = (p: AttachmentProblem) => `${batch ? `emails.${p.index}.` : ''}attachments${p.attachment === undefined ? '' : `.${p.attachment}`}`;
  const line = (p: AttachmentProblem) => `${path(p)}: ${p.message.replace(/\.$/, '')}`, first = problems[0]!;
  const limits = problems.some(p => p.code === 'ATTACHMENT_LIMIT_EXCEEDED') ? ` ${ATTACHMENT_LIMITS_TEXT}` : '';
  const message = problems.every(p => p.mailApp) ? `Message not sent: ${[...new Set(problems.map(p => p.message))].join('; ')}.`
    : `${problems.length > 1 ? `${problems.length} attachment problems: ` : ''}${problems.map(line).join('; ')}.${limits}`;
  const error = new ApiError(first.status, first.code, message, path(first));
  error.attachmentTypes = first.types;
  error.details = problems.map(p => ({ ...(batch ? { index: p.index } : {}), ...(p.attachment === undefined ? {} : { attachment: p.attachment }), ...(p.id ? { id: p.id } : {}),
    ...(p.filename ? { filename: p.filename } : {}), code: p.code, message: line(p) }));
  return error;
}
// DUPLICATE_ATTACHMENT is a request's shape, answered before any file is looked up, and stays as it is.
const ATTACHMENT_REFUSALS = new Set(['ATTACHMENT_NOT_FOUND', 'ATTACHMENT_LIMIT_EXCEEDED', 'DUPLICATE_CONTENT_ID', 'ATTACHMENT_METADATA_INVALID']);
/** Before admitted: send_admission's attachment refusal (the first problem, for one email) becomes every problem in the send. */
export async function refusedAttachments(runtime: Runtime, a: Actor, d: Admitted | Refused, out: Outgoing[], batch: boolean) {
  if (d.allowed || !ATTACHMENT_REFUSALS.has(d.code)) return;
  const lists = out.map(m => m.snapshot.attachments), ids = [...new Set(lists.flat())];
  const rows = ids.length ? await runtime.db.select().from(attachments).where(and(scope(attachments, a), scopedAttachment(a), inArray(attachments.id, ids))) : [];
  const problems = attachmentProblems(lists, new Map(rows.map(row => [row.id, row])));
  if (problems.length) throw attachmentRefusal(problems, batch);
}
export function sesHeaders(count: number) {
  if (count>15) throw new ApiError(422,'TOO_MANY_HEADERS','SES accepts at most 15 message headers including unsubscribe and threading headers.','headers');
}
export function distinctAttachmentIds(ids: string[]) {
  if (new Set(ids).size !== ids.length) throw duplicateAttachment();
  return ids;
}
export function validateAttachmentRows(ids: string[], rows: AttachmentFacts[]) {
  // A draft keeps files whose metadata SES would refuse (stored before that check); sending them is refused at admission.
  const problems = attachmentProblems([ids], new Map(rows.map(row => [row.id, row]))).filter(p => p.code !== 'ATTACHMENT_METADATA_INVALID');
  if (problems.length) throw attachmentRefusal(problems, false);
}
export async function attachmentRows(db: DbExecutor, a: Actor, ids: string[], lock = false, conversation = false) {
  if (!ids.length) return [];
  const query = db.select().from(attachments).where(and(scope(attachments, a), scopedAttachment(a, conversation), inArray(attachments.id, distinctAttachmentIds(ids)))).orderBy(asc(attachments.id));
  const rows = await (lock ? query.for('update') : query);
  validateAttachmentRows(ids, rows);
  return rows;
}
export async function linkAttachments(db: DbExecutor, a: Actor, ids: string[], ownerType: 'email' | 'campaign' | 'review', ownerId: string, lockedAttachments?: (typeof attachments.$inferSelect)[], conversation = false) {
  // A campaign may reuse metadata already ownership-checked and locked in this same transaction.
  if (!lockedAttachments) await attachmentRows(db, a, ids, true, conversation);
  if (ids.length) await db.insert(attachmentLinks).values(ids.map(attachmentId => ({ workspaceId: a.workspaceId, attachmentId, ownerType, ownerId }))).onConflictDoNothing();
}
export function escaped(value: string) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
export function formattedSender(from: string, fromName?: string, foldMime = false): string {
  // Domain authorization always uses the bare address; formatting happens only at the MIME/SES boundary.
  Address.parse(from);
  if (!fromName) return from;
  // Current admission validates FromName. A queued display name is data, not a new admission:
  // one that no longer passes the policy is left out and the bare address is sent.
  if (!FromName.safeParse(fromName).success) return from;
  fromName = decodedDisplayName(fromName);
  if (/^[\x20-\x7e]+$/.test(fromName)) return `"${fromName.replace(/["\\]/g, '\\$&')}" <${from}>`;
  // RFC 2047 encoded words, each below 75 characters and never splitting a UTF-8 code point.
  const words: string[] = []; let chunk = '';
  for (const character of fromName) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 42) { words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`); chunk = ''; }
    chunk += character;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  const separator = foldMime ? '\r\n ' : ' ';
  return `${words.join(separator)}${separator}<${from}>`;
}
// SES Simple puts CID images beside the body in multipart/mixed. Build only
// the inline-image case ourselves so each image is related to its HTML part.
// The message is written once into one buffer of its exact size: text as it is built, each file's base64 (76-character
// lines) straight from its bytes. A 25 MiB attachment then costs its own bytes and the message, nothing between.
type Segment = string | { file: Uint8Array };
const LINE_BYTES = 57, ENCODE_CHUNK = LINE_BYTES * 1024;
const base64Size = (n: number) => { const chars = Math.ceil(n / 3) * 4; return chars + 2 * Math.max(0, Math.ceil(chars / 76) - 1); };
function writeSegments(segments: Segment[]): Uint8Array {
  const size = segments.reduce((n, segment) => n + (typeof segment === 'string' ? Buffer.byteLength(segment) : base64Size(segment.file.length)), 0);
  const out = Buffer.allocUnsafe(size);
  let at = 0;
  for (const segment of segments) {
    if (typeof segment === 'string') { at += out.write(segment, at); continue; }
    const file = segment.file;
    for (let i = 0; i < file.length; i += ENCODE_CHUNK) {
      const encoded = Buffer.from(file.buffer, file.byteOffset + i, Math.min(ENCODE_CHUNK, file.length - i)).toString('base64');
      for (let j = 0; j < encoded.length; j += 76) {
        if (i || j) at += out.write('\r\n', at);
        at += out.write(encoded.slice(j, j + 76), at, 'latin1');
      }
    }
  }
  if (at !== size) throw new Error('MIME size mismatch');
  return out;
}
export function inlineMessage(snapshot: EmailSnapshot, parts: Attachment[], archive?:{id:string;date:string}): Uint8Array {
  const crlf = '\r\n';
  const encodedWords = (value: string) => {
    const words: string[] = []; let chunk = '';
    for (const character of value) {
      if (Buffer.byteLength(chunk + character) > 45) { words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`); chunk = ''; }
      chunk += character;
    }
    if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
    return words.join(`${crlf} `);
  };
  const quotedPrintable = (value: string) => {
    const lines: string[] = []; let line = '';
    const flush = (soft: boolean) => { lines.push(soft ? `${line}=` : line.replace(/[ \t]$/, c => c === ' ' ? '=20' : '=09')); line = ''; };
    for (const byte of Buffer.from(value.replace(/\r\n|\r|\n/g, '\n'), 'utf8')) {
      if (byte === 0x0a) { flush(false); continue; }
      const token = byte === 0x3d || (byte < 0x20 && byte !== 0x09) || byte > 0x7e ? `=${byte.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(byte);
      if (line.length + token.length > 73) flush(true);
      line += token;
    }
    flush(false);
    return lines.join(crlf);
  };
  const textPart = (type: 'plain' | 'html', body: string): Segment[] => [`Content-Type: text/${type}; charset=UTF-8${crlf}Content-Transfer-Encoding: quoted-printable${crlf}${crlf}${quotedPrintable(body)}`];
  const multipart = (type: 'related' | 'alternative' | 'mixed', children: Segment[][]): Segment[] => {
    const boundary = `nightmail_${archive ? `${archive.id}_${type}` : crypto.randomUUID()}`;
    return [`Content-Type: multipart/${type}; boundary="${boundary}"${type === 'related' ? '; type="text/html"' : ''}${crlf}${crlf}`,
      ...children.flatMap(child => [`--${boundary}${crlf}`, ...child, crlf]), `--${boundary}--${crlf}`];
  };
  const filePart = (part: Attachment): Segment[] => {
    if (!part.RawContent || !part.FileName || !part.ContentType || /[\r\n]/.test(part.ContentType) || (part.ContentId && !/^[a-zA-Z0-9_.@-]+$/.test(part.ContentId))) throw new ApiError(422, 'INVALID_MIME_ATTACHMENT', 'Attachment metadata cannot be encoded safely.');
    // RFC 2231 continuations preserve Unicode/quotes and keep filename lines short.
    const filename = [...Buffer.from(part.FileName)].map(byte => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('').match(/.{1,60}/g)!;
    const disposition = part.ContentDisposition === 'INLINE' ? 'inline' : 'attachment';
    const parameters = filename.map((value, index) => ` filename*${index}*=${index === 0 ? "UTF-8''" : ''}${value}`).join(`;${crlf}`);
    return [`Content-Type: ${part.ContentType}${crlf}Content-Transfer-Encoding: base64${crlf}Content-Disposition: ${disposition};${crlf}${parameters}${crlf}` +
      (part.ContentId ? `Content-ID: <${part.ContentId}>${crlf}` : '') + crlf, { file: part.RawContent }];
  };
  const inline = parts.filter(part => part.ContentDisposition === 'INLINE');
  const files = parts.filter(part => part.ContentDisposition !== 'INLINE');
  let body = snapshot.html === undefined ? textPart('plain',snapshot.text??'') : textPart('html',snapshot.html);
  if(inline.length)body=multipart('related',[body,...inline.map(filePart)]);
  if (snapshot.html!==undefined && snapshot.text !== undefined) body = multipart('alternative', [textPart('plain', snapshot.text), body]);
  if (files.length) body = multipart('mixed', [body, ...files.map(filePart)]);
  // Bcc stays only in the SES envelope, never the MIME headers.
  const headers = [
    `From: ${formattedSender(snapshot.from, snapshot.fromName, true)}`,
    `To: ${snapshot.to.join(`,${crlf} `)}`,
    ...(snapshot.cc.length ? [`Cc: ${snapshot.cc.join(`,${crlf} `)}`] : []),
    ...(snapshot.replyTo.length ? [`Reply-To: ${snapshot.replyTo.join(`,${crlf} `)}`] : []),
    `Subject: ${/^[\x20-\x7e]{1,900}$/.test(snapshot.subject) && !snapshot.subject.includes('=?') ? snapshot.subject : encodedWords(snapshot.subject)}`,
    `Date: ${new Date(archive?.date??Date.now()).toUTCString()}`,
    ...(archive?[`Message-ID: <${archive.id}@nightmail.invalid>`]:[]),
    'MIME-Version: 1.0',
    ...snapshot.headers.map(header => {
      if (!/^[A-Za-z0-9-]+$/.test(header.Name) || /[\r\n]/.test(header.Value)) throw new ApiError(422, 'INVALID_MIME_HEADER', 'Message headers cannot contain line breaks.');
      return `${header.Name}: ${header.Value}`;
    }),
  ];
  // Body/attachment lines are bounded by their encoders. Check only message
  // headers rather than splitting a potentially multi-megabyte MIME body.
  if (headers.some(header => header.split(crlf).some(line => Buffer.byteLength(line) > 998))) throw new ApiError(422, 'MIME_LINE_TOO_LONG', 'An encoded message header exceeds the SMTP line limit.');
  const bytes = writeSegments([[...headers, ''].join(crlf), ...body]);
  if (bytes.length > SEND_LIMITS.encodedBytes) throw new ApiError(413, 'ENCODED_MESSAGE_TOO_LARGE', `Encoded MIME exceeds the ${SEND_LIMITS.encodedBytes / 1_000_000} MB message limit.`);
  return bytes;
}
export function withPreheader(html: string | undefined, previewText: string | undefined, parse: HtmlParser | undefined, version = CAMPAIGN_RENDERER_VERSION): string | undefined {
  if (!html || !previewText) return html;
  if (!parse) throw new Error('HTML parser required');
  const stack: DefaultTreeAdapterMap['node'][] = [parse(html, { sourceCodeLocationInfo: true })];
  let bodyOffset = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if ('tagName' in node && node.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      if (node.tagName === 'body') bodyOffset = node.sourceCodeLocation?.startTag?.endOffset ?? 0;
    }
    if ('childNodes' in node) stack.push(...node.childNodes);
  }
  const preheader = `<div ${version===1?'data-opensend-preview':'data-bane-preview'}="true" data-skip-in-text="true" style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escaped(previewText)}</div>`;
  return html.slice(0, bodyOffset) + preheader + html.slice(bodyOffset);
}
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'poster', 'background', 'cite', 'longdesc', 'data', 'codebase', 'profile', 'manifest', 'xlink:href']);
const TEXT_ATTRIBUTES = new Set(['title', 'alt', 'aria-label', 'aria-description']);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'iframe', 'xmp', 'noembed', 'noframes', 'noscript', 'plaintext']);
function validateUrl(value: string) {
  // The HTML parser has already decoded all character references (not just a regex subset).
  const normalized = value.replace(/[\x00-\x20\x7f]/g, '');
  let url: URL;
  try { url = new URL(normalized, 'https://template.invalid/'); } catch { throw new ApiError(422, 'UNSAFE_HTML_URL', 'HTML contains an invalid URL.'); }
  if (!['http:', 'https:', 'mailto:', 'tel:', 'cid:'].includes(url.protocol)) throw new ApiError(422, 'UNSAFE_HTML_URL', 'HTML URLs must use HTTP(S), mailto, tel, CID, or relative references.');
}
type HtmlPlaceholderAnalysis = { hasUrlPlaceholder: boolean; hasAttrPlaceholder: boolean; attrPlaceholderCount: number };
function inspectHtml(source: string, root: DefaultTreeAdapterMap['node'], template = false): HtmlPlaceholderAnalysis {
  const safe: { start: number; end: number; kind: 'text' | 'textAttr' | 'urlAttr' }[] = [];
  const stack: { node: DefaultTreeAdapterMap['node']; unsafe: boolean }[] = [{ node: root, unsafe: false }];
  while (stack.length) {
    const { node, unsafe } = stack.pop()!;
    const element = 'tagName' in node ? node : undefined;
    const blocked = unsafe || !!element && (RAW_TEXT_ELEMENTS.has(element.tagName) || element.namespaceURI !== 'http://www.w3.org/1999/xhtml');
    if (node.nodeName === '#text' && !blocked && node.sourceCodeLocation) {
      const { startOffset: start, endOffset: end } = node.sourceCodeLocation;
      // HTML error recovery can coalesce text across ignored markup. Never trust such a
      // broad location as a text-only range; literal less-than signs should use &lt;.
      if (!source.slice(start, end).includes('<')) safe.push({ start, end, kind: 'text' });
    }
    if (element) {
      for (const attr of element.attrs) {
        const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
        // Template structure is checked before rendering; validate complete URLs only after substitution.
        // Office markup carries its links and images under a prefix (o:href on VML), read like the plain attribute.
        if (!template && (URL_ATTRIBUTES.has(name) || /:(?:href|src)$/.test(name))) validateUrl(attr.value);
        if (!template && ['srcset', 'imagesrcset', 'ping', 'archive'].includes(name)) {
          const urls = name.endsWith('srcset') ? attr.value.split(',').map(part => part.trim().split(/\s+/)[0]!) : attr.value.trim().split(/\s+/);
          for (const url of urls) if (url) validateUrl(url);
        }
        if (template && !blocked && (URL_ATTRIBUTES.has(name) || TEXT_ATTRIBUTES.has(name))) {
          const location = element.sourceCodeLocation?.attrs?.[name];
          if (!location) continue;
          const original = source.slice(location.startOffset, location.endOffset);
          // Parser offsets identify the attribute; this only checks its lexical quoting, never parses HTML.
          const quoted = original.match(/^[^\s=]+\s*=\s*(["'])/);
          if (quoted && original.endsWith(quoted[1]!)) safe.push({ start: location.startOffset + quoted[0].length, end: location.endOffset - 1, kind: URL_ATTRIBUTES.has(name) ? 'urlAttr' : 'textAttr' });
        }
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) stack.push({ node: child, unsafe: blocked });
    // A template's content, and markup a lenient client may read where this parser kept data (bounded-html.ts).
    if ('content' in node) stack.push({ node: (node as DefaultTreeAdapterMap['template']).content, unsafe: blocked });
  }
  safe.sort((a, b) => a.start - b.start); let rangeIndex = 0;
  let hasUrlPlaceholder = false, hasAttrPlaceholder = false, attrPlaceholderCount = 0;
  if (template) for (const match of source.matchAll(/{{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*}}/g)) {
    while (safe[rangeIndex] && safe[rangeIndex]!.end <= match.index) rangeIndex++;
    const range = safe[rangeIndex];
    if (!range || match.index < range.start || match.index + match[0].length > range.end) throw new ApiError(422, 'UNSAFE_TEMPLATE_CONTEXT', 'Campaign placeholders require HTML text nodes or quoted URL/title/alt/aria-label/aria-description attributes. Unquoted attributes, tag names, comments, script/style, event handlers and foreign markup are unsupported.');
    if (range.kind === 'urlAttr') hasUrlPlaceholder = true;
    if (range.kind !== 'text') { hasAttrPlaceholder = true; attrPlaceholderCount++; }
  }
  return { hasUrlPlaceholder, hasAttrPlaceholder, attrPlaceholderCount };
}
export function validateInterpolationTemplate(source: string | undefined, html: boolean, parse?: HtmlParser): HtmlPlaceholderAnalysis {
  if (!source) return { hasUrlPlaceholder: false, hasAttrPlaceholder: false, attrPlaceholderCount: 0 };
  const unsupported = source.replace(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g, '');
  // Nested CSS blocks legitimately end in }}. Only an unmatched opening delimiter begins unsupported template syntax.
  if (unsupported.includes('{{')) throw new ApiError(422, 'UNSUPPORTED_TEMPLATE_SYNTAX', 'Campaigns support simple {{name}} substitutions, not helpers, HTML fragments, or Liquid syntax.');
  if (html) {
    if (!parse) throw new Error('HTML parser required');
    return inspectHtml(source, parse(source, {sourceCodeLocationInfo:true}), true);
  }
  return { hasUrlPlaceholder: false, hasAttrPlaceholder: false, attrPlaceholderCount: 0 };
}
/** Differential-test helper: validates HTML placeholders and reports whether any sit in a URL or text attribute. */
export async function analyzeHtmlPlaceholders(html: string): Promise<HtmlPlaceholderAnalysis> {
  return validateInterpolationTemplate(html, true, await loadParse5());
}
export function interpolate(source: string | undefined, values: Record<string, unknown>, html: boolean, templateValidated = false, parse?: HtmlParser): string | undefined {
  if (!source) return source;
  if (!templateValidated) validateInterpolationTemplate(source, html, parse);
  let result = ''; let offset = 0;
  for (const match of source.matchAll(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g)) {
    const key = match[1]!;
    if (!Object.hasOwn(values, key) || values[key] === undefined || values[key] === null) throw new ApiError(422, 'MISSING_TEMPLATE_VARIABLE', `This email uses {{${key}}} but has no value for it. Add a fallback value for ${key} (defaults.${key}).`, key);
    const value = html ? escaped(String(values[key])) : String(values[key]);
    const prefix = source.slice(offset, match.index);
    if (result.length + prefix.length + value.length > MAX_BODY) throw new ApiError(413, 'RENDERED_CONTENT_TOO_LARGE', 'A personalized body part exceeds 512 KiB characters. Reduce the content or repeated substitutions.');
    result += prefix + value; offset = match.index + match[0].length;
  }
  if (result.length + source.length - offset > MAX_BODY) throw new ApiError(413, 'RENDERED_CONTENT_TOO_LARGE', 'A personalized body part exceeds 512 KiB characters. Reduce the content or repeated substitutions.');
  return result + source.slice(offset);
}
export async function validateHtmlUrls(html: string | undefined) {
  if (html) {
    // Every reading a mail client may give the markup: a link only Outlook shows is checked like any other.
    const root = (await loadBoundedHtml()).boundedHtmlFragment(html, 'document', { clients: true });
    if (!root) throw new ApiError(422,'CONTENT_TOO_LARGE_TO_SCREEN','Simplify the HTML so it can be validated safely.','html');
    inspectHtml(html, root);
  }
}
export function sizeCheck(snapshot: EmailSnapshot, rows: { size: number }[]) {
  if (estimatedMimeBytes(snapshot, rows) > SEND_LIMITS.encodedBytes) throw new ApiError(413, 'ENCODED_MESSAGE_TOO_LARGE', `Estimated encoded MIME exceeds the ${SEND_LIMITS.encodedBytes / 1_000_000} MB message limit, Amazon SES's maximum.`);
}
// The renderer owns the MIME content, not the envelope or custom headers. A
// substituted Subject can contain physical header lines, including obsolete From : forms.
export function renderedMimeHeaders(block:string) {
  const headers:string[]=[],seen=new Set<string>();
  for (const field of block.split(/\r\n(?![ \t])/)) {
    const allowed=/^(subject|mime-version|content-[a-z0-9-]+):/i.exec(field);
    if (!allowed) continue; // Drop the entire untrusted field, continuations included.
    const name=allowed[1]!.toLowerCase(),unfolded=field.replace(/\r\n[ \t]+/g,' ');
    if (seen.has(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(unfolded)) throw new ApiError(422,'INVALID_RENDERED_MIME','SES rendered an ambiguous or invalid MIME header.');
    seen.add(name);
    // Preserve legal folding only when unfolding would exceed the SMTP line limit.
    if (field.split('\r\n').some(line=>Buffer.byteLength(line)>998)) throw new ApiError(422,'INVALID_RENDERED_MIME','A rendered MIME header line exceeds the SMTP limit.');
    headers.push(Buffer.byteLength(unfolded)>998?field:unfolded);
  }
  return headers;
}
/** The Hosted content rules a message goes out under: the probation copy, as written under the image rule, or as written. */
export type ContentRules = 'probation' | 'standard' | null;
/**
 * How one message is screened and delivered, decided the same at accept (screenOutgoingAtAccept), for held mail
 * (screenHeldMail), for a campaign's copies (campaignRules) and at dispatch (sending/claim.ts prepareMail). `hosted`: shared
 * sending with the Hosted screen on. `trusted`: the trusted pool tier, never for a built-in domain's mail, which gets a
 * new sender's rules whatever the connection's tier. `screened`: the classifier reads it; `required`: a verdict must
 * exist before it is sent.
 */
export function resolveHostedContentPolicy(config: Pick<Runtime['config'], 'hostedScreen' | 'trustedPool' | 'builtinDomain'>,
  m: { shared: boolean; poolTier?: string | null; legacyNames?: boolean | null; from: string; probation: boolean; simulated: boolean; kind: EmailSnapshot['kind']; screen?: boolean }) {
  const hosted = m.shared && !!config.hostedScreen, builtin = isBuiltinHost(config, m.from.split('@')[1] ?? '');
  const trusted = !builtin && !!config.trustedPool && m.poolTier === 'trusted' && m.legacyNames === false;
  const rules: ContentRules = m.simulated || !hosted || trusted ? null : m.probation || builtin ? 'probation' : 'standard';
  return { shared: m.shared, hosted, trusted, rules, screened: !m.simulated && (hosted || (!!m.screen && m.kind === 'transactional')), required: hosted && (!trusted || m.kind === 'marketing') };
}
export type HostedContentPolicy = ReturnType<typeof resolveHostedContentPolicy>;
/** Shared sending sends only structured content, and a signed or encrypted message as written only from the trusted tier:
 *  a probation sender's mail goes out as the copy the screen read (protocol-submit.ts sealedPassthrough). */
export function sharedFormatRefusal(s: Pick<EmailSnapshot, 'raw' | 'mime'>, policy: Pick<HostedContentPolicy, 'shared' | 'trusted'>) {
  if (policy.shared && s.raw) return new ApiError(422, 'SHARED_RAW_UNSUPPORTED', 'Hosted sending requires structured SES content.');
  if (policy.shared && s.mime && !policy.trusted) return new ApiError(422, 'SEALED_MAIL_UNAVAILABLE', 'Signed and encrypted mail goes out as written, which a sender can do once its first messages are evaluated.');
}

/** The raw upload's body, at most MAX_ATTACHMENT_BYTES, read from the request stream without another copy when its length is known. */
export async function uploadBody(request: Request, length: number | null, filename: string): Promise<Uint8Array> {
  const tooLarge = () => fileTooLarge(filename, null, MAX_ATTACHMENT_BYTES);
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  try {
    if (length !== null) {
      const out = new Uint8Array(length);
      let at = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (at + value.byteLength > length) throw new ApiError(400, 'REQUEST_BODY_INVALID', 'The body is longer than its Content-Length.');
        out.set(value, at); at += value.byteLength;
      }
      if (at !== length) throw new ApiError(400, 'REQUEST_BODY_INVALID', 'The body is shorter than its Content-Length.');
      return out;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ATTACHMENT_BYTES) throw tooLarge();
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
    return out;
  } finally { void reader.cancel().catch(() => {}); }
}
/** How long a download's response may take to be read before it is ended and its file let go (tests shorten it). */
export const attachmentDownload = { idleMs: 6_000, readMs: 60_000 };
export async function saveAttachment(c: Ctx, a: Actor, metadata: AttachmentMetadataInput, bytes: Uint8Array, max = MAX_ATTACHMENT_BYTES) {
  sesAttachment(metadata);
  const input = validateAttachment(metadata, bytes, max);
  const checksum = await bytesDigest(bytes);
  const upload=attachmentUpload(c.env,a,input,bytes,checksum,a.tokenId ?? a.keyId);
  try { return await idempotent(c.env.db,keyed(c,a),{...input,size:bytes.length,checksum},async db=>AttachmentInfo.parse(await upload.finish(db)),{prepare:upload.put}); }
  finally { await upload.refund(); }
}
function attachmentUpload(runtime:Runtime,a:Pick<Actor,'workspaceId'>,input:ReturnType<typeof validateAttachment>,bytes:Uint8Array,checksum:string,uploadedBy?:string){
  const attachmentId=id('attachment'),storageKey=uploadKey(a.workspaceId,attachmentId);
  const upload=uploadReservation(runtime,a.workspaceId,attachmentId,storageKey,bytes,input.contentType);
  return {
    put:upload.put,
    async finish(db:DbExecutor){
      await upload.claim(db);
      const [row]=await db.insert(attachments).values({id:attachmentId,workspaceId:a.workspaceId,uploadedBy,...input,storageKey,checksum,size:bytes.length}).returning();return row!;
    },
    refund:upload.refund,
  };
}
/** Reserve quota before uploading. No database connection is held during object storage I/O.
 * Unused uploads (including a concurrent idempotency loser) use ordinary attachment retention. */
export async function storeAttachmentBytes(runtime: Runtime, a: Pick<Actor,'workspaceId'>, metadata: { filename: string; contentType: string; disposition?: 'attachment' | 'inline'; contentId?: string }, bytes: Uint8Array, uploadedBy?: string) {
  sesAttachment(metadata);
  const parsed = AttachmentMetadata.safeParse({ filename: metadata.filename, contentType: metadata.contentType, disposition: metadata.disposition ?? 'attachment', ...(metadata.contentId ? { contentId: metadata.contentId } : {}) });
  if (!parsed.success) throw metadataInvalid(metadata, invalidMetadataFields(parsed.error.issues));
  const upload=attachmentUpload(runtime,a,validateAttachment(parsed.data,bytes),bytes,await bytesDigest(bytes),uploadedBy);
  try {await upload.put();return await runtime.db.transaction(upload.finish);}finally{await upload.refund();}
}
export async function bytesDigest(bytes: Uint8Array) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), n => n.toString(16).padStart(2, '0')).join(''); }
// Fully verified bytes are reused across invocations sharing the same bucket binding (its cacheScope), in one
// least-recently-used cache for the isolate of at most SEND_LIMITS.attachmentCacheBytes. Its bytes count against the
// isolate's memory budget (src/isolate-memory.ts), which drops the oldest when a reservation needs their room.
// Pending reads remain local to each Storage wrapper/invocation: Workers cannot await I/O owned by a different request.
const attachmentScopes = new WeakMap<object, number>();
let attachmentScopeCount = 0;
const attachmentCache = { bytes: 0, entries: new Map<string, Uint8Array>() };
function evictAttachments(bytes: number) {
  for (const [key, body] of attachmentCache.entries) {
    if (bytes <= 0) return;
    attachmentCache.entries.delete(key); attachmentCache.bytes -= body.length; bytes -= body.length;
  }
}
registerMemoryCache({ bytes: () => attachmentCache.bytes, evict: evictAttachments });
const attachmentLoads = new WeakMap<Storage, Map<string, Promise<Uint8Array>>>();
/** Object storage threw on a read (R2 or S3 down or timing out), as opposed to answering without the object. Retryable:
 *  the dispatcher holds a shard's attachment mail together until it is back (src/sending/quota.ts STORAGE_MS). */
let liveReads = 0;
/** How many attachment reads storage has answered in this isolate (not served from the cache): a dispatcher batch whose
 *  count moved knows storage is back. */
export const attachmentReads = () => liveReads;
export const storageUnavailable = () => new ApiError(503, 'STORAGE_TEMPORARILY_UNAVAILABLE', 'Attachment storage is temporarily unavailable; the message will be retried.', undefined, true);
export async function verifiedAttachment(runtime: Runtime, row: typeof attachments.$inferSelect) {
  const scope = runtime.storage.cacheScope ?? runtime.storage, cache = attachmentCache;
  let scopeId = attachmentScopes.get(scope);
  if (scopeId === undefined) attachmentScopes.set(scope, scopeId = ++attachmentScopeCount);
  const key = `${scopeId}:${row.storageKey}:${row.checksum}:${row.size}`;
  const cached = cache.entries.get(key);
  if (cached) { cache.entries.delete(key); cache.entries.set(key, cached); return cached; }
  let pending = attachmentLoads.get(runtime.storage);
  if (!pending) { pending = new Map(); attachmentLoads.set(runtime.storage, pending); }
  const existing = pending.get(key);
  if (existing) return existing;
  const load = (async () => {
    const asset = await runtime.storage.get(row.storageKey).catch(error => {
      if (error instanceof ApiError || error instanceof ModuleLoadError) throw error;
      throw storageUnavailable();
    });
    liveReads++;
    if (!asset || asset.body.length !== row.size || await bytesDigest(asset.body) !== row.checksum) throw new ApiError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE', 'An immutable attachment is missing or changed.', undefined, true);
    const already = cache.entries.get(key);
    if (already) return already;
    const limit = SEND_LIMITS.attachmentCacheBytes;
    if (asset.body.length <= limit) {
      evictAttachments(cache.bytes + asset.body.length - limit);
      cache.entries.set(key, asset.body); cache.bytes += asset.body.length;
      fitMemoryCaches();
    }
    return asset.body;
  })();
  pending.set(key, load);
  try { return await load; } finally { if (pending.get(key) === load) pending.delete(key); }
}
