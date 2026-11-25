import { decodeWords } from 'postal-mime';
import { z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { Buffer } from 'node:buffer';
import { productName } from './brand.js';
import { ATTACHMENT_FIELD_RULES, ATTACHMENT_LIMITS_TEXT, UPLOAD_HEADERS } from './attachment-limits.js';
import { ApiError } from './core.js';
import { SEND_LIMITS } from './send-limits.js';

// Shared validation for sending, audience/consent and template reply addresses.
export const mailAddress = (base=z.string()) => base.email({pattern:/^(?!\.)(?!.*\.\.)[a-z0-9_'+.\-]*[a-z0-9_+\-]@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,}|xn--[a-z0-9][a-z0-9-]*[a-z0-9])$/i}).max(254).regex(/^[\x21-\x7e]+$/, 'Use ASCII email addresses (punycode domains are supported).')
  .refine(v => v.indexOf('@') <= 64 && v.slice(v.indexOf('@')+1).split('.').every(label => label.length <= 63), 'The local part may not exceed 64 bytes or a domain label 63 bytes.');

// Exact SQL counterpart to mailAddress() for set-based static campaign preparation.
// Differential-tested against mailAddress() across adversarial addresses (quoted locals, IDN/punycode, trailing/double
// dots, 64/63/254 byte limits, control chars, whitespace, mixed case) with zero disagreements.
export const validMailAddressSql = (expr: ReturnType<typeof sql>) => sql`(
  ${expr} IS NOT NULL
  AND octet_length(${expr}) BETWEEN 1 AND 254
  AND octet_length(${expr}) = char_length(${expr})
  AND left(${expr}, 1) <> '.'
  AND strpos(${expr}, '..') = 0
  AND (${expr}) ~ '^[A-Za-z0-9_''+.-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?[.])+(?:[A-Za-z]{2,}|[Xx][Nn]--[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])$'
  AND (
    octet_length(${expr}) <= 64
    OR (
      position('@' in (${expr})) BETWEEN 2 AND 65
      AND substring((${expr}) FROM position('@' in (${expr})) + 1) !~ '[^.]{64}'
    )
  )
)`;

// A sender display name may not read as an address or an angle-bracketed route in any client, and may not carry the
// characters that reorder or hide what a client renders. The address check runs on a folded copy of the name, built
// the way Unicode TR39 builds a confusable skeleton: NFD, format characters removed, each character replaced by its
// confusables.txt prototype, NFD again. The table below is that data (version 18.0.0) for every source that is not a
// letter and whose prototype contains @, < or > or TR39's angle bracket exemplars ❬ and ❭, plus every source whose
// prototype is the letter a or A. Letters drawn as arrowheads (hiragana く, Canadian syllabics ᐳ) stay letters, as names
// are written in them. TR39 and NFKC both read an enclosed a as the letter, so circled a becomes @ before NFKC folds
// the remaining compatibility forms, and a or A under a combining enclosing mark becomes @ after it; combining marks
// are then removed so none can sit between the characters that matter. Joiners stay allowed in the name itself, for
// emoji and script shaping, as do the weak directional marks some names need to display correctly.
const CONTROL = /[\x00-\x1f\x7f-\x9f\u180e\u2028\u2029\u202a-\u202e\u2066-\u2069\ufff9-\ufffb\u{e0001}\u{e0020}-\u{e007f}]/u;
const CONFUSABLES = new Map<number, string>([
  [0x251, 'a'], [0x2C2, '<'], [0x2C3, '>'], [0x391, 'A'], [0x3B1, 'a'], [0x410, 'A'], [0x430, 'a'], [0x13AA, 'A'], [0x15C5, 'A'], [0x2039, '<'],
  [0x203A, '>'], [0x226A, '<<'], [0x226B, '>>'], [0x22D6, '<\u{B7}'], [0x22D7, '\u{B7}>'], [0x22D8, '<<<'], [0x22D9, '>>>'], [0x237A, 'a'],
  [0x276E, '<'], [0x276F, '>'], [0x27E8, '\u{276C}'], [0x27E9, '\u{276D}'], [0x2A20, '>>'], [0x2AA5, '><'], [0x3008, '\u{276C}'],
  [0x3009, '\u{276D}'], [0x31DB, '\u{276C}'], [0xA4EE, 'A'], [0xAB64, 'a'], [0xFE64, '<'], [0xFE65, '>'], [0xFE6B, '@'], [0xFF1C, '<'],
  [0xFF1E, '>'], [0xFF20, '@'], [0xFF21, 'A'], [0xFF41, 'a'], [0x102A0, 'A'], [0x16F40, 'A'], [0x1CCD6, 'A'], [0x1D236, '<'], [0x1D237, '>'],
  [0x1D400, 'A'], [0x1D41A, 'a'], [0x1D434, 'A'], [0x1D44E, 'a'], [0x1D468, 'A'], [0x1D482, 'a'], [0x1D49C, 'A'], [0x1D4B6, 'a'], [0x1D4D0, 'A'],
  [0x1D4EA, 'a'], [0x1D504, 'A'], [0x1D51E, 'a'], [0x1D538, 'A'], [0x1D552, 'a'], [0x1D56C, 'A'], [0x1D586, 'a'], [0x1D5A0, 'A'], [0x1D5BA, 'a'],
  [0x1D5D4, 'A'], [0x1D5EE, 'a'], [0x1D608, 'A'], [0x1D622, 'a'], [0x1D63C, 'A'], [0x1D656, 'a'], [0x1D670, 'A'], [0x1D68A, 'a'], [0x1D6A8, 'A'],
  [0x1D6C2, 'a'], [0x1D6E2, 'A'], [0x1D6FC, 'a'], [0x1D71C, 'A'], [0x1D736, 'a'], [0x1D756, 'A'], [0x1D770, 'a'], [0x1D790, 'A'], [0x1D7AA, 'a'],
  [0x1DF5A, 'a'], [0x1DF6A, 'A']]);
const skeleton = (value: string) => Array.from(value.normalize('NFD').replace(/\p{Cf}/gu, ''), c => CONFUSABLES.get(c.codePointAt(0)!) ?? c).join('').normalize('NFD');
export const foldedDisplayName = (value: string) => skeleton(value).replace(/[\u24b6\u24d0\u{1f150}]/gu, '@').normalize('NFKC').normalize('NFD')
  .replace(/[aA]\p{M}*[\u20dd-\u20e0\u20e2-\u20e4]/gu, '@').replace(/\u276c/g, '<').replace(/\u276d/g, '>').replace(/[\p{M}\p{Cf}]/gu, '');
const plainNameAllowed = (value: string) => !CONTROL.test(value) && !/[@<>]/.test(foldedDisplayName(value));
export const decodedDisplayName = (value: string) => value.includes('=?') ? decodeWords(value) : value;
export function displayNameAllowed(value: string) {
  if (!plainNameAllowed(value)) return false;
  if (!value.includes('=?')) return true;
  try {
    const decoded = decodedDisplayName(value);
    return !!decoded.trim() && !decoded.includes('=?') && !decoded.includes('�') && plainNameAllowed(decoded);
  } catch { return false; }
}
export const senderDisplayName = () => z.string().max(200).refine(displayNameAllowed, 'Sender name cannot contain an address, angle brackets, or control characters.');

// A campaign's own unsubscribe page. It is only ever a link in the message and a redirect target, never fetched, so it
// needs HTTPS and no credentials; the recipient is named by their unsubscribe token, never by address or internal ID.
// Checked as sent: nothing (z.string().url() included) may trim or drop whitespace before these rules see it.
export const UNSUBSCRIBE_PAGE_PARAM = 'unsubscribe_token';
const unsubscribePageAllowed = (value: string) => {
  if (!/^https:\/\//i.test(value) || /[\s\x00-\x1f\x7f]/.test(value) || /^[^/?#]*@/.test(value.slice(8))) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password; } catch { return false; }
};
// The page's own unsubscribe_token, in any encoding URLSearchParams decodes, would sit beside the recipient's and a page
// reading the first one would unsubscribe someone else.
const ownToken = (value: string) => { try { return new URL(value).searchParams.has(UNSUBSCRIBE_PAGE_PARAM); } catch { return false; } };
export const unsubscribePageUrl = () => z.string().max(1000).refine(unsubscribePageAllowed, 'Use an https:// address without a user name, password or spaces.')
  .refine(value => !ownToken(value), `Remove ${UNSUBSCRIBE_PAGE_PARAM} from the address: ${productName} adds each recipient's own.`).openapi({ format: 'uri' })
  .describe(`Your own unsubscribe or preference page: HTTPS, no user name, password, whitespace or ${UNSUBSCRIBE_PAGE_PARAM} parameter, at most 1,000 characters. The footer's Unsubscribe link opens it with ${UNSUBSCRIBE_PAGE_PARAM}=<token> added; your page records the opt-out by POSTing that token to /unsubscribe/<token> on this API (idempotent). List-Unsubscribe keeps this API's one-click address, which records the opt-out itself and, opened in a browser, confirms it and then continues to your page. Omit to use the hosted page.`);
/** The recipient's link to a campaign's own unsubscribe page: the page with exactly one unsubscribe_token, theirs. Any
 *  other unsubscribe_token is dropped; every other query parameter, as written, and the fragment stay. */
export function unsubscribePageLink(page: string, token: string): string {
  const url = new URL(page);
  const kept = url.search.slice(1).split('&').filter(part => part && !new URLSearchParams(part).has(UNSUBSCRIBE_PAGE_PARAM));
  url.search = [...kept, `${UNSUBSCRIBE_PAGE_PARAM}=${token}`].join('&');
  return url.href;
}

// A workspace's postal address: US law (CAN-SPAM) requires one in every commercial email. Plain text, shown under the
// Unsubscribe link of every campaign footer and every marketing send (src/sending.ts marketingFooter). Line breaks are
// kept, each line trimmed and empty ones dropped (postalAddressText); no markup, control or bidirectional characters.
export const POSTAL_ADDRESS = { chars: 300, lines: 6 } as const;
const POSTAL_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
export const postalAddressText = (value: string) => value.split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean).join('\n');
export const PostalAddress = z.string().trim().min(1).max(POSTAL_ADDRESS.chars)
  .refine(value => postalAddressText(value).split('\n').length <= POSTAL_ADDRESS.lines, `Use at most ${POSTAL_ADDRESS.lines} lines.`)
  .refine(value => !/[<>]/.test(value) && !POSTAL_CONTROL.test(value), 'Use plain text: no HTML, angle brackets or control characters.')
  .describe(`The workspace's postal address, as plain text: at most ${POSTAL_ADDRESS.chars} characters on up to ${POSTAL_ADDRESS.lines} lines, without HTML. Every campaign email and marketing send shows it under the Unsubscribe link, as US law (CAN-SPAM) requires; a campaign can't be sent or scheduled without it.`);

/** The workspace's postal address, a scalar subquery: Hosted keeps it beside the workspace's name, self-hosted in its settings row. */
export const postalAddressOf = (multiTenant: boolean, workspaceId: string) => multiTenant
  ? sql<string | null>`(SELECT postal_address FROM workspaces WHERE id=${workspaceId})`
  : sql<string | null>`(SELECT postal_address FROM operation_settings WHERE workspace_id=${workspaceId})`;
export const postalAddressRequired = () => new ApiError(422, 'POSTAL_ADDRESS_REQUIRED', 'Add the workspace’s postal address before sending or scheduling a campaign: US law (CAN-SPAM) requires it in every marketing email, under the Unsubscribe link. Set postalAddress in Settings (updateWorkspaceSettings).', 'postalAddress');

export const MAX_ATTACHMENT_BYTES = SEND_LIMITS.attachmentBytes;
/** A file sent as base64 inside JSON: 8 MiB decoded (SEND_LIMITS.jsonAttachmentBytes). */
export const MAX_JSON_ATTACHMENT_BYTES = SEND_LIMITS.jsonAttachmentBytes;
// Base64 of 8 MiB plus padding and the line breaks MIME tools and SDKs insert.
export const MAX_ATTACHMENT_BASE64 = 12 * 1024 * 1024;
export const mib = (bytes: number) => `${bytes / 1024 / 1024} MiB`;
// https://docs.aws.amazon.com/ses/latest/dg/mime-types.html: SES rejects these extensions; everything else is deliverable.
const BANNED_EXTENSIONS = new Set(['ade', 'adp', 'app', 'asp', 'bas', 'bat', 'cer', 'chm', 'cmd', 'com', 'cpl', 'crt', 'csh', 'der', 'exe', 'fxp', 'gadget', 'hlp', 'hta', 'inf', 'ins', 'isp', 'its', 'js', 'jse', 'ksh', 'lib', 'lnk',
  'mad', 'maf', 'mag', 'mam', 'maq', 'mar', 'mas', 'mat', 'mau', 'mav', 'maw', 'mda', 'mdb', 'mde', 'mdt', 'mdw', 'mdz', 'msc', 'msh', 'msh1', 'msh2', 'mshxml', 'msh1xml', 'msh2xml', 'msi', 'msp', 'mst', 'ops', 'pcd', 'pif', 'plg', 'prf', 'prg',
  'reg', 'scf', 'scr', 'sct', 'shb', 'shs', 'sys', 'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'tmp', 'url', 'vb', 'vbe', 'vbs', 'vps', 'vsmacros', 'vss', 'vst', 'vsw', 'vxd', 'ws', 'wsc', 'wsf', 'wsh', 'xnk']);

export const AttachmentFilename = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f/\\]+$/, `Use ${ATTACHMENT_FIELD_RULES.filename}.`);
export const AttachmentContentType = z.string().max(SEND_LIMITS.mimeFieldChars).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?: *;[ -~]*)?$/, `Use ${ATTACHMENT_FIELD_RULES.contentType}.`);
export const AttachmentContentId = z.string().min(1).max(SEND_LIMITS.mimeFieldChars).regex(/^[a-zA-Z0-9_.@-]+$/, `Use ${ATTACHMENT_FIELD_RULES.contentId}.`);
export const AttachmentDisposition = z.enum(['attachment', 'inline']);
/** A size as a person reads it, exact in bytes too once it is large: 512 bytes, 9.4 KiB (9,612 bytes), 31.2 MiB (32,712,345 bytes). */
export const sizeText = (bytes: number) => bytes < 1024 ? `${bytes} byte${bytes === 1 ? '' : 's'}` : `${(bytes / 1024 ** (bytes < 1024 ** 2 ? 1 : 2)).toFixed(1)} ${bytes < 1024 ** 2 ? 'KiB' : 'MiB'} (${bytes.toLocaleString('en-US')} bytes)`;
/** The value a caller sent for an attachment field, quoted and cut short (metadata, never a file's content). */
export const quoted = (value: unknown) => { const text = String(value); return JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}…` : text); };
/**
 * ATTACHMENT_METADATA_INVALID naming every field that is wrong at once: what was sent (or that it is missing), and what
 * it must be. `headers`: the fields came from POST /v1/attachments/upload's headers, so each names its header.
 */
export function metadataInvalid(input: Partial<Record<keyof typeof ATTACHMENT_FIELD_RULES, unknown>>, fields: (keyof typeof ATTACHMENT_FIELD_RULES)[], headers = false, extra: Record<string, string> = {}) {
  const wrong = [...new Set(fields)].map(field => {
    const value = input[field], from = headers ? ` (${UPLOAD_HEADERS[field]} header)` : '';
    const problem = extra[field] ?? `must be ${ATTACHMENT_FIELD_RULES[field]}`;
    return { field, problem: `${field}${from} ${value === undefined || value === '' ? 'is missing' : `is ${quoted(value)}`}: it ${problem}` };
  });
  const error = new ApiError(422, 'ATTACHMENT_METADATA_INVALID', `${wrong.length > 1 ? `${wrong.length} attachment fields are invalid` : 'An attachment field is invalid'}: ${wrong.map(w => w.problem).join('; ')}.`, wrong[0]?.field);
  error.details = wrong.map(w => ({ field: w.field, value: input[w.field] === undefined ? null : String(input[w.field]).slice(0, 200), message: w.problem }));
  return error;
}
/** The metadata fields a parse found wrong. */
export const invalidMetadataFields = (issues: readonly { path: PropertyKey[] }[]) => issues.flatMap(issue => typeof issue.path[0] === 'string' && issue.path[0] in ATTACHMENT_FIELD_RULES ? [issue.path[0] as keyof typeof ATTACHMENT_FIELD_RULES] : []);
export const AttachmentMetadata = z.object({ filename: AttachmentFilename, contentType: AttachmentContentType.default('application/octet-stream'), disposition: AttachmentDisposition.default('attachment'), contentId: AttachmentContentId.optional() }).strict();
export const AttachmentUpload = AttachmentMetadata.extend({ content: z.string().min(4).max(MAX_ATTACHMENT_BASE64).describe('Base64 (standard or URL-safe alphabet; line breaks are accepted). No data URLs. At most 8 MiB decoded in JSON; upload larger files, up to 25 MiB, as raw bytes to POST /v1/attachments/upload.') }).strict().openapi('AttachmentUpload');
export type AttachmentMetadataInput = z.infer<typeof AttachmentMetadata>;

/** Decodes base64 as SDKs actually emit it: standard or URL-safe alphabet, with or without padding, line breaks and spaces ignored. */
export function decodeBase64(content: string, field = 'content'): Uint8Array {
  // Flat character classes only: repeated groups would exhaust the stack on multi-megabyte uploads.
  const compact = content.replace(/[\r\n\t ]+/g, '');
  const unpadded = compact.replace(/=+$/, '');
  // Why it isn't base64, from its shape alone: a single offending character at most, never the content.
  const invalid = () => {
    const at = unpadded.search(/[^A-Za-z0-9+/_-]/);
    const why = /^data:[^,]*,/i.test(compact) ? 'it starts with a data: URL prefix: send only the base64 after the comma'
      : at >= 0 ? `character ${at + 1} (spaces and line breaks removed) is ${JSON.stringify(unpadded[at])}, which is not in the base64 alphabet (A-Z, a-z, 0-9, + and /, or - and _)`
      : compact.length - unpadded.length > 2 ? `it ends in ${compact.length - unpadded.length} = padding characters, and base64 has at most 2`
      : `its ${unpadded.length.toLocaleString('en-US')} characters without padding can't be base64 (one character past a multiple of 4)`;
    return new ApiError(422, 'INVALID_BASE64', `Attachment content must be base64 of the file's bytes (standard or URL-safe alphabet; spaces and line breaks are ignored), but ${why}.`, field);
  };
  if (!/^[A-Za-z0-9+/_-]*$/.test(unpadded) || unpadded.length % 4 === 1 || compact.length - unpadded.length > 2) throw invalid();
  const bytes = Buffer.from(unpadded, 'base64');
  if (bytes.length !== Math.floor(unpadded.length * 3 / 4)) throw invalid();
  return bytes;
}

/** Size caps and the SES banned-extension list are the only content rules; type, charset and file signatures are the caller's business. */
export function blockedExtension(filename: string) {
  // Windows ignores trailing dots and spaces when it opens a file, so "payload.exe. " is still an executable.
  const name = filename.replace(/[. ]+$/, ''), dot = name.lastIndexOf('.'), extension = dot > 0 ? name.slice(dot + 1).trim().toLowerCase() : '';
  return BANNED_EXTENSIONS.has(extension) ? extension : null;
}
/** One file over the per-file limit (or empty): its size, the limit its route has, and the way to send it instead. */
export function fileTooLarge(filename: string, bytes: number | null, max: number) {
  const json = max < MAX_ATTACHMENT_BYTES;
  const what = bytes === 0 ? 'is empty' : bytes === null ? `is more than ${mib(max)}` : `is ${sizeText(bytes)} decoded`;
  const instead = bytes === 0 ? 'Upload the file\'s bytes.' : json ? `That route takes at most ${mib(max)}: upload files up to ${mib(MAX_ATTACHMENT_BYTES)} as raw bytes to POST /v1/attachments/upload instead.`
    : `No file may be larger than ${mib(max)}: link to it from the email instead.`;
  const error = new ApiError(413, 'ATTACHMENT_LIMIT_EXCEEDED', `Attachment ${quoted(filename)} ${what}. ${instead} ${ATTACHMENT_LIMITS_TEXT}`);
  error.details = [{ limit: json ? 'jsonFile' : 'file', maxBytes: max, bytes }];
  return error;
}
export function validateAttachment<T extends AttachmentMetadataInput>(metadata: T, bytes: Uint8Array, max = MAX_ATTACHMENT_BYTES): T {
  if (!bytes.length || bytes.length > max) throw fileTooLarge(metadata.filename, bytes.length, max);
  const extension = blockedExtension(metadata.filename);
  if (extension) throw new ApiError(422, 'UNSUPPORTED_ATTACHMENT_TYPE', `Amazon SES does not deliver .${extension} attachments (${quoted(metadata.filename)}): it refuses executable and script types (.exe, .bat, .js, .vbs and others). Zip the file, or link to it.`, 'filename');
  if (metadata.disposition === 'inline' && !metadata.contentId) throw new ApiError(422, 'INLINE_ATTACHMENT_INVALID', `An inline attachment needs a contentId: ${ATTACHMENT_FIELD_RULES.contentId}. Without one, use disposition attachment.`, 'contentId');
  return metadata;
}
