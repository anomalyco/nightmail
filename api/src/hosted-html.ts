/**
 * The HTML of a Hosted message as it is delivered and screened: one canonical copy. The body is parsed once, as a
 * document, the tree is sanitized, and the accepted tree is serialized; that serialization is what goes to SES, and the
 * screen's text, its destination inventory and the verdict key come from the same tree. A duplicate attribute is read
 * and delivered once (the first, as every HTML parser reads it). The copy is read again until it reads as itself, so a
 * client parses exactly what was screened.
 *
 * Removed, because a client could draw or load something from them that the screen can't read: text-generating and
 * code-running CSS (src/hosted-css.ts), fonts from anywhere but a font service and style sheets from anywhere but
 * Google Fonts (FontSources), SVG fonts, scripts, templates, frames, plugins (an <object>'s fallback content stays),
 * <link> other than a style sheet (preload and prefetch hints included), refresh and Link <meta>, comments other than
 * Outlook's conditional ones, SVG animation of an address or style, srcset (the image keeps its src), archive,
 * xml:base, MathML altimg and definitionURL, inline data: addresses, and resources in SVG presentation attributes. An
 * Outlook conditional comment is delivered as written, its markup screened in place, unless any of it would be removed
 * or holds a duplicate attribute; then the whole comment goes.
 *
 * Refused (the sender must fix it), because what it leads to depends on where the message is opened: <base>, and any
 * link or resource address that is not absolute http(s), mailto, tel, cid: or a #fragment.
 */
import { defaultTreeAdapter, html as spec, serializeOuter, type DefaultTreeAdapterMap } from 'parse5';
import { boundedHtmlFragment } from './bounded-html.js';
import { hostedDeclarations, hostedSheet, loadsResource, type FontPolicy } from './hosted-css.js';

type Node = DefaultTreeAdapterMap['childNode'];
type Parent = DefaultTreeAdapterMap['parentNode'];
type Element = DefaultTreeAdapterMap['element'];
type Document = DefaultTreeAdapterMap['document'];
const SVG = spec.NS.SVG;

/**
 * Where a URL leads, as a recipient's client resolves it: WHATWG URL parsing with IDNA (so a host with a combining
 * mark is its punycode, not the host it looks like), the canonical scheme, host, port, path, query and fragment, and
 * nothing removed beyond what URL parsing itself removes. Never prose-normalized. Null unless the value is an absolute
 * http(s), mailto or tel URL whose meaning doesn't depend on the document's address: an http(s) URL needs its two
 * slashes, since `https:host` and `https:/host` are relative to an https page.
 */
export function destination(value: string): string | null {
  const v = value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '');
  if (!/^(?:https?:[\\/]{2}|mailto:|tel:)/i.test(v)) return null;
  try { return new URL(v).href; } catch { return null; }
}
export const destinationHost = (target: string) => { try { return /^https?:$/.test(new URL(target).protocol) ? new URL(target).hostname : ''; } catch { return ''; } };
// What a style sheet, style attribute or other CSS may load: absolute http(s) only.
const resource = (value: string) => { const target = destination(value); return target && /^https?:/.test(target) ? target : null; };
/**
 * Where a message may load fonts from: a font can draw any text in place of the text the screen reads, so only from
 * font services whose fonts senders can't upload (JEV_FONT_HOSTS), over https, and from the installation's own font
 * directory (`prefix`, the campaign editor's Inter). Style sheets, which can declare fonts and generate text, only
 * from Google Fonts.
 */
export type FontSources = { hosts: string[]; prefix?: string };
export const DEFAULT_FONT_HOSTS = ['fonts.gstatic.com', 'fonts.googleapis.com', 'use.typekit.net', 'p.typekit.net', 'fonts.bunny.net'];
const SHEET_HOSTS = ['fonts.googleapis.com'];
function fontPolicy({ hosts, prefix }: FontSources): FontPolicy {
  const own = prefix ? resource(prefix) : null, host = (target: string) => target.startsWith('https://') ? new URL(target).host : '';
  return { font: target => hosts.includes(host(target)) || (!!own && target.startsWith(own)), sheet: target => SHEET_HOSTS.includes(host(target)) };
}

// The URL-bearing attribute vocabulary (HTML, SVG, MathML and Office markup); docs/sending-limits.md has the table.
// Read as destinations: one address each; Office prefixes any name (o:href, v:src).
const URL_ATTRIBUTES = new Set(['href', 'src', 'background', 'poster', 'action', 'formaction', 'cite', 'longdesc', 'usemap', 'data', 'codebase', 'classid', 'code', 'profile', 'manifest', 'icon', 'lowsrc', 'dynsrc', 'xlink:href']);
// Lists of addresses separated by ASCII whitespace (link auditing): read, or removed when any is not absolute http(s).
const URL_LISTS = new Set(['ping', 'attributionsrc']);
// Removed: candidate lists a client splits its own way, another base, and MathML's image and definition addresses.
const STRIPPED_ATTRIBUTES = new Set(['srcset', 'imagesrcset', 'imagesizes', 'archive', 'xml:base', 'altimg', 'definitionurl']);
const isUrlAttribute = (name: string) => URL_ATTRIBUTES.has(name) || URL_LISTS.has(name) || STRIPPED_ATTRIBUTES.has(name) || /:(?:href|src)$/.test(name);
// SVG presentation attributes whose value is CSS that may load a resource.
const CSS_ATTRIBUTES = new Set(['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'cursor', 'color-profile']);
const REMOVED_ELEMENTS = new Set(['script', 'template', 'iframe', 'noembed', 'noframes', 'frame', 'frameset', 'embed', 'param']);
const UNWRAPPED_ELEMENTS = new Set(['object', 'applet']);
const ANIMATIONS = new Set(['animate', 'animatecolor', 'set']);
// SVG fonts draw their own glyphs.
const SVG_FONTS = new Set(['font', 'font-face', 'font-face-src', 'font-face-uri', 'font-face-format', 'font-face-name', 'glyph', 'missing-glyph', 'altglyph', 'altglyphdef', 'altglyphitem', 'glyphref', 'hkern', 'vkern']);
// Outlook reads the inside of <!--[if mso]>…<![endif]--> (src/bounded-html.ts); <!--[if !mso]><!--> and <!--<![endif]-->
// only mark where its content starts and ends.
const CONDITIONAL = /^\[if\b[^\]<>]*\]>[\s\S]*<!\[endif\]$/i, MARKER = /^(?:\[if\b[^\]<>]*\]><!|<!\[endif\])$/i;

export type HostedHtml = {
  /** The canonical copy: the serialization of `root`, delivered exactly. */
  html: string; root: Document;
  /** Every distinct place the copy links to or loads from. */
  destinations: Set<string>;
  /** Markup refused because what it leads to depends on where the message is opened. */
  unsupported: string[];
  /** What canonicalization removed from the submitted HTML, for the sender. */
  removed: string[];
  /** Every element the submitted HTML has, removed ones included, for the sender's lint (src/sendability.ts). */
  tags: Set<string>;
  /** Hosts whose fonts or style sheets were removed, for the sender. */
  fonts: string[];
};
type Sink = { destinations: Set<string>; unsupported: string[]; removed: string[]; changes: number; tags: Set<string>; fonts: string[]; policy: FontPolicy; css: Map<string, ReturnType<typeof hostedDeclarations>> };
const foreign = (sink: Sink, host: string) => { if (!sink.fonts.includes(host)) sink.fonts.push(host); note(sink.removed, `Custom font from ${host} removed`); };
// Mail repeats the same inline styles on every row and cell: each distinct one is read once per pass.
const declarations = (sink: Sink, value: string) => { let read = sink.css.get(value); if (!read) { read = hostedDeclarations(value, resource); sink.css.set(value, read); } return read; };
const note = (list: string[], what: string) => { if (!list.includes(what) && list.length < 20) list.push(what); };

/** One pass: parse, sanitize, serialize. `frozen` reads an Outlook conditional comment's markup without changing it. */
function sanitize(parent: Parent | DefaultTreeAdapterMap['commentNode'], sink: Sink, frozen: boolean, placeholders: boolean, ambiguous: Set<object>) {
  const children = (parent as Parent).childNodes;
  if (!children) return;
  const remove = (node: Node, what?: string) => {
    sink.changes++;
    if (what) note(sink.removed, what);
    if (!frozen) children.splice(children.indexOf(node), 1);
  };
  for (const node of [...children]) {
    if (node.nodeName === '#comment') {
      const comment = node as DefaultTreeAdapterMap['commentNode'], data = comment.data.trim();
      if (frozen || !CONDITIONAL.test(data)) { if (frozen || !MARKER.test(data)) remove(node); continue; }
      const inner: Sink = { ...sink, destinations: new Set(), unsupported: [], removed: [], changes: 0 };
      sanitize(comment, inner, true, placeholders, ambiguous);
      if (inner.changes || ambiguous.has(comment)) { remove(node, 'an Outlook conditional comment holding markup Hosted sending removes'); continue; }
      for (const target of inner.destinations) sink.destinations.add(target);
      for (const what of inner.unsupported) note(sink.unsupported, what);
      continue;
    }
    if (!('tagName' in node)) continue;
    const element = node as Element, tag = element.tagName.toLowerCase();
    sink.tags.add(tag);
    if (REMOVED_ELEMENTS.has(tag)) { remove(node, `<${tag}>`); continue; }
    if (tag === 'link') {
      if (!element.attrs.some(a => a.name === 'rel' && a.value.toLowerCase().split(/[\t\n\f\r ]+/).includes('stylesheet'))) { remove(node, '<link> other than a style sheet'); continue; }
      const target = resource(element.attrs.find(a => a.name === 'href')?.value ?? '');
      if (!target || !sink.policy.sheet(target)) { if (target) foreign(sink, new URL(target).host); remove(node, target ? undefined : 'a style sheet <link> without an absolute address'); continue; }
    }
    if (SVG_FONTS.has(tag) && element.namespaceURI === SVG) { remove(node, 'an SVG font'); continue; }
    if (tag === 'meta' && element.attrs.some(a => a.name === 'http-equiv' && /^\s*(?:refresh|link|set-cookie)\s*$/i.test(a.value))) { remove(node, '<meta http-equiv="refresh">'); continue; }
    if (ANIMATIONS.has(tag) && element.namespaceURI === SVG) {
      const target = element.attrs.find(a => a.name === 'attributeName')?.value.trim().toLowerCase() ?? '';
      if (isUrlAttribute(target) || isUrlAttribute(target.replace(/^[^:]*:/, '')) || CSS_ATTRIBUTES.has(target) || target === 'style') { remove(node, `SVG <${element.tagName}> of an address or style`); continue; }
    }
    if (tag === 'base') note(sink.unsupported, '<base>');
    if (tag === 'style') {
      attributes(element, tag, sink, frozen, placeholders);
      const css = element.childNodes.map(child => 'value' in child ? child.value : '').join(''), read = hostedSheet(css, resource, sink.policy);
      if (read.removed.length) { sink.changes++; for (const what of read.removed) note(sink.removed, what); }
      for (const host of read.fonts) if (!sink.fonts.includes(host)) sink.fonts.push(host);
      for (const target of read.destinations) sink.destinations.add(target);
      if (!frozen && (read.css !== css || element.childNodes.some(child => !('value' in child)))) {
        sink.changes++;
        if (!read.css) { children.splice(children.indexOf(node), 1); continue; }
        element.childNodes = [];
        defaultTreeAdapter.insertText(element, read.css);
      }
      continue;
    }
    if (UNWRAPPED_ELEMENTS.has(tag)) {
      // A plugin isn't loaded; its fallback content is what a client shows.
      sanitize(element, sink, frozen, placeholders, ambiguous);
      sink.changes++; note(sink.removed, `<${tag}>`);
      if (!frozen) { children.splice(children.indexOf(node), 1, ...element.childNodes); for (const child of element.childNodes) child.parentNode = parent as Parent; }
      continue;
    }
    attributes(element, tag, sink, frozen, placeholders);
    sanitize(element, sink, frozen, placeholders, ambiguous);
  }
}
function attributes(element: Element, tag: string, sink: Sink, frozen: boolean, placeholders: boolean) {
  const drop = (attribute: { name: string }, what: string) => {
    sink.changes++; note(sink.removed, what);
    if (!frozen) element.attrs = element.attrs.filter(a => a !== attribute);
  };
  for (const a of [...element.attrs]) {
    const name = (a.prefix ? `${a.prefix}:${a.name}` : a.name).toLowerCase(), value = a.value;
    if (STRIPPED_ATTRIBUTES.has(name)) { drop(a, `the ${name} attribute`); continue; }
    if (name === 'style') {
      const read = declarations(sink, value);
      for (const target of read.destinations) sink.destinations.add(target);
      if (read.removed.length) { sink.changes++; for (const what of read.removed) note(sink.removed, what); }
      if (!frozen && read.css !== value) { sink.changes++; if (read.css) a.value = read.css; else element.attrs = element.attrs.filter(b => b !== a); }
      continue;
    }
    if (CSS_ATTRIBUTES.has(name) && loadsResource(value)) { drop(a, `a url() in <${tag} ${name}>`); continue; }
    if (placeholders && /^[\x00-\x20]*\{\{/.test(value)) continue;
    if (URL_LISTS.has(name)) {
      const targets = value.split(/[\t\n\f\r ]+/).filter(Boolean).map(resource);
      if (targets.every(Boolean)) for (const target of targets) sink.destinations.add(target!);
      else drop(a, `<${tag} ${name}> with an address that is not absolute http(s)`);
      continue;
    }
    if (!URL_ATTRIBUTES.has(name) && !/:(?:href|src)$/.test(name)) continue;
    // A fragment or an empty value stays in the message; cid: names one of its attachments.
    if (/^[\x00-\x20]*(?:#|$)/.test(value) || /^[\x00-\x20]*cid:/i.test(value)) continue;
    if (/^[\x00-\x20]*data:/i.test(value)) { drop(a, `an inline data: address in <${tag} ${name}>`); continue; }
    const target = destination(value);
    if (target) sink.destinations.add(target);
    else note(sink.unsupported, `<${tag} ${name}> that is not an absolute http(s), mailto or tel address`);
  }
}
// A doctype as written, so a message keeps its rendering mode (an XHTML Transitional doctype is almost-standards mode).
function doctype(node: DefaultTreeAdapterMap['documentType']) {
  const id = (v: string) => v.includes('"') ? `'${v}'` : `"${v}"`;
  if (!node.name) return '<!DOCTYPE>';
  return `<!DOCTYPE ${node.name}${node.publicId ? ` PUBLIC ${id(node.publicId)}${node.systemId ? ` ${id(node.systemId)}` : ''}` : node.systemId ? ` SYSTEM ${id(node.systemId)}` : ''}>`;
}
function pass(html: string, placeholders: boolean, policy: FontPolicy) {
  const ambiguous = new Set<object>(), sink: Sink = { destinations: new Set(), unsupported: [], removed: [], changes: 0, tags: new Set(), fonts: [], policy, css: new Map() };
  const root = boundedHtmlFragment(html, 'document', { clients: true, onParseError: (error, within) => {
    if (error.code !== 'duplicate-attribute') return;
    if (within) ambiguous.add(within); else note(sink.removed, 'a repeated attribute (the first is kept)');
  } });
  if (!root) return null;
  sanitize(root, sink, false, placeholders, ambiguous);
  // Mail is read without scripting: <noscript> holds markup, written as such.
  const serialized = root.childNodes.map(node => node.nodeName === '#documentType' ? doctype(node as DefaultTreeAdapterMap['documentType']) : serializeOuter(node, { scriptingEnabled: false })).join('');
  return { html: serialized, root, ...sink };
}
/** How a body is read: whether addresses may start with a placeholder, and where fonts may come from. */
export type HostedOptions = { placeholders?: boolean; fonts?: FontSources };
/**
 * The canonical copy of an HTML body, or null when it is over the parser's budgets or doesn't read as itself after a
 * few passes. With `placeholders`, a campaign's own copy may start an address with a placeholder; each recipient's copy
 * is read without it.
 */
export function hostedHtml(html: string, { placeholders = false, fonts = { hosts: DEFAULT_FONT_HOSTS } }: HostedOptions = {}): HostedHtml | null {
  const policy = fontPolicy(fonts);
  let input = html, read = pass(input, placeholders, policy);
  if (!read) return null;
  const { removed, tags, fonts: foreignFonts } = read;
  for (let i = 0; i < 3 && (read.changes || read.html !== input); i++) {
    input = read.html;
    read = pass(input, placeholders, policy);
    if (!read) return null;
  }
  if (read.changes || read.html !== input) return null;
  return { html: read.html, root: read.root as Document, destinations: read.destinations, unsupported: read.unsupported, removed, tags, fonts: foreignFonts };
}
