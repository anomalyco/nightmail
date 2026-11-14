/**
 * The HTML of a Hosted message as it is delivered and screened: one canonical copy. The body is parsed once, as a
 * document, the tree is reduced to an allow-list of elements and attributes, and the result is serialized; that
 * serialization is what goes to SES, and the screen's text, its destination inventory and the verdict key come from the
 * same tree. A duplicate attribute is read and delivered once (the first, as every HTML parser reads it). The copy is
 * read again until it reads as itself, so a client parses exactly what was screened.
 *
 * Kept: the elements in ELEMENTS (document structure, text, links, images, tables, headings, lists and inline
 * formatting), only with the attributes `allowed` names, CSS through its own allow-list (src/hosted-css.ts, which keeps
 * the CSS text as written less whole declarations and rules), fonts and style sheets only from font services
 * (FontSources), and Outlook conditional comments whose markup passes unchanged (otherwise the whole comment goes).
 * Everything else is removed: an element outside the list gives its place to its content, except the ones a client
 * draws its own text or controls for (form controls, scripts, frames, plugins, SVG, MathML, templates, noscript,
 * details, marquee, ruby, media), which go with their content. What the screen reads of this tree is its text in
 * document order, with each image's alt text in its place (src/screen.ts).
 *
 * Refused (the sender must fix it), because what it leads to depends on where the message is opened: <base>, and any
 * link or image address that is not absolute http(s), mailto, tel, cid: or a #fragment.
 */
import { defaultTreeAdapter, html as spec, serializeOuter, type DefaultTreeAdapterMap } from 'parse5';
import { boundedHtmlFragment } from './bounded-html.js';
import { hostedDeclarations, hostedSheet, type FontPolicy } from './hosted-css.js';
import { screenedText } from './screened-html.js';

type Node = DefaultTreeAdapterMap['childNode'];
type Parent = DefaultTreeAdapterMap['parentNode'];
type Element = DefaultTreeAdapterMap['element'];
type Document = DefaultTreeAdapterMap['document'];
const HTML = spec.NS.HTML;

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
 * Where a message may load fonts and style sheets from: a font can draw any text in place of the text the screen reads,
 * and a sheet can generate text, so only from font services whose fonts senders can't upload (JEV_FONT_HOSTS), over
 * https; font files also from the installation's own font directory (`prefix`, the campaign editor's Inter).
 */
export type FontSources = { hosts: string[]; prefix?: string };
export const DEFAULT_FONT_HOSTS = ['fonts.gstatic.com', 'fonts.googleapis.com', 'use.typekit.net', 'p.typekit.net', 'fonts.bunny.net'];
function fontPolicy({ hosts, prefix }: FontSources): FontPolicy {
  const own = prefix ? resource(prefix) : null, host = (target: string) => target.startsWith('https://') ? new URL(target).host : '';
  return { font: target => hosts.includes(host(target)) || (!!own && target.startsWith(own)), sheet: target => hosts.includes(host(target)) };
}

// The elements a Hosted message keeps.
const ELEMENTS = new Set(['html', 'head', 'body', 'title', 'meta', 'style', 'div', 'span', 'p', 'br', 'hr', 'a', 'img', 'table', 'thead', 'tbody', 'tfoot',
  'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'sup', 'sub', 'blockquote', 'pre',
  'code', 'center', 'font']);
// Removed with their content: a client draws text, controls or media of its own for these (or runs or loads them).
const REMOVED_WITH_CONTENT = new Set(['script', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'noframes', 'object', 'applet', 'embed', 'param',
  'noembed', 'svg', 'math', 'form', 'input', 'textarea', 'button', 'select', 'option', 'optgroup', 'datalist', 'output', 'meter', 'progress', 'keygen',
  'details', 'summary', 'dialog', 'marquee', 'ruby', 'rt', 'rp', 'rb', 'rtc', 'audio', 'video', 'canvas', 'map', 'area', 'portal']);
// Attributes any kept element may have: none of them is drawn as text or loads anything.
const PRESENTATION = new Set(['style', 'class', 'id', 'dir', 'lang', 'role', 'width', 'height', 'align', 'valign', 'bgcolor', 'border', 'cellpadding',
  'cellspacing', 'colspan', 'rowspan']);
// ARIA attributes that hold states, numbers or element references, never text of their own (aria-label and
// aria-description do, so they are not here).
const ARIA = new Set(['aria-hidden', 'aria-level', 'aria-labelledby', 'aria-describedby', 'aria-live', 'aria-atomic', 'aria-relevant', 'aria-busy',
  'aria-current', 'aria-expanded', 'aria-controls', 'aria-owns', 'aria-colcount', 'aria-colindex', 'aria-colspan', 'aria-rowcount', 'aria-rowindex',
  'aria-rowspan', 'aria-setsize', 'aria-posinset', 'aria-selected', 'aria-checked', 'aria-disabled', 'aria-pressed', 'aria-readonly', 'aria-required',
  'aria-sort', 'aria-orientation', 'aria-haspopup', 'aria-modal', 'aria-multiline', 'aria-multiselectable', 'aria-invalid', 'aria-details',
  'aria-errormessage', 'aria-flowto', 'aria-activedescendant', 'aria-autocomplete', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow']);
// And by element: a link's address and target, an image's address and alt text (read where the image is), a font's
// presentation, a <meta>'s charset or viewport, and two that change nothing in HTML: <style type="text/css">, which is
// what a style sheet is anyway, and the XML namespace declarations of an XHTML document's <html>.
const ATTRIBUTES: Record<string, (name: string, value: string) => boolean> = {
  html: name => name === 'xmlns' || name.startsWith('xmlns:'),
  a: name => name === 'href' || name === 'target',
  img: name => name === 'src' || name === 'alt',
  font: name => name === 'color' || name === 'face' || name === 'size',
  meta: name => name === 'charset' || name === 'name' || name === 'content' || name === 'http-equiv',
  style: (name, value) => name === 'type' && /^\s*text\/css\s*$/i.test(value),
};
const allowed = (tag: string, name: string, value: string) =>
  (PRESENTATION.has(name) && (name !== 'dir' || /^(?:ltr|rtl)$/i.test(value.trim()))) || ARIA.has(name) || !!ATTRIBUTES[tag]?.(name, value);
// <meta charset>, the http-equiv form of it, and the viewport: nothing else a <meta> says is kept.
const meta = (element: Element) => {
  const get = (name: string) => element.attrs.find(a => a.name === name)?.value.trim().toLowerCase();
  return get('charset') !== undefined || get('name') === 'viewport' || get('http-equiv') === 'content-type';
};
// What the sender is told was removed names elements and attributes from HTML's vocabulary, never other text of theirs.
const VOCABULARY = new Set([...ELEMENTS, ...REMOVED_WITH_CONTENT, 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside', 'address', 'figure',
  'figcaption', 'picture', 'source', 'track', 'link', 'base', 'col', 'colgroup', 'caption', 'dl', 'dt', 'dd', 'label', 'fieldset', 'legend', 'abbr',
  'acronym', 'cite', 'q', 'dfn', 'kbd', 'samp', 'var', 'mark', 'del', 'ins', 'big', 'strike', 'tt', 'nobr', 'wbr', 'bdi', 'bdo', 'time', 'data', 'xmp',
  'plaintext', 'listing', 'slot', 'menu', 'dir', 'hgroup', 'search', 'xml', 'basefont', 'spacer', 'blink', 'image', 'isindex', 'menuitem', 'title', 'name',
  'rel', 'rev', 'type', 'start', 'value', 'reversed', 'background', 'text', 'vlink', 'alink', 'hspace', 'vspace', 'nowrap', 'noshade', 'size', 'face',
  'color', 'target', 'href', 'src', 'srcset', 'sizes', 'alt', 'usemap', 'ismap', 'loading', 'decoding', 'fetchpriority', 'crossorigin', 'referrerpolicy',
  'integrity', 'media', 'charset', 'content', 'http-equiv', 'scope', 'headers', 'axis', 'char', 'charoff', 'frame', 'rules', 'summary', 'span', 'tabindex',
  'accesskey', 'contenteditable', 'draggable', 'hidden', 'spellcheck', 'translate', 'autofocus', 'inert', 'popover', 'is', 'itemscope', 'itemtype',
  'itemprop', 'itemid', 'itemref', 'nonce', 'part', 'leftmargin', 'topmargin', 'marginwidth', 'marginheight', 'longdesc', 'ping', 'download', 'hreflang',
  'datetime', 'placeholder', 'action', 'method', 'xml:lang', 'xml:space', 'aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext',
  'aria-placeholder', 'aria-braillelabel', 'aria-brailleroledescription', 'aria-keyshortcuts', 'compact', 'clear', 'shape', 'coords', 'codebase',
  'classid', 'archive', 'code', 'profile', 'manifest', 'poster', 'controls', 'autoplay', 'loop', 'muted', 'preload', 'srcdoc', 'sandbox', 'allow',
  'frameborder', 'scrolling', 'form', 'list', 'max', 'min', 'maxlength', 'pattern', 'readonly', 'required', 'selected', 'checked', 'disabled', 'open',
  'rows', 'cols', 'autocomplete', 'attributionsrc', 'as', 'async', 'defer', 'for', 'kind', 'default', 'standby', 'bordercolor']);
const known = (name: string) => VOCABULARY.has(name) ? name : /^data-/.test(name) ? 'data-*' : /^on/.test(name) ? 'event handler'
  : /^(?:v|o|w|x|m):/.test(name) ? `Office ${name.slice(0, 2)}*` : 'non-HTML';
// Embeddings, overrides and isolates: an override draws the letters after it in reverse.
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/;
// Outlook reads the inside of <!--[if mso]>…<![endif]--> (src/bounded-html.ts); <!--[if !mso]><!--> and <!--<![endif]-->
// only mark where its content starts and ends.
const CONDITIONAL = /^\[if\b[^\]<>]*\]>[\s\S]*<!\[endif\]$/i, MARKER = /^(?:\[if\b[^\]<>]*\]><!|<!\[endif\])$/i;

export type HostedHtml = {
  /** The canonical copy: the serialization of `root`, delivered exactly (mail delivered as submitted: the submission). */
  html: string; root: Document;
  /** Every distinct place the copy links to or loads from. */
  destinations: Set<string>;
  /** Markup refused because what it leads to depends on where the message is opened. */
  unsupported: string[];
  /** What canonicalization removed from the submitted HTML, for the sender; mail delivered as submitted that asks to
   *  be screened is refused when it has any. */
  removed: string[];
  /** Every element the submitted HTML has, removed ones included, for the sender's lint (src/sendability.ts). */
  tags: Set<string>;
  /** Hosts whose fonts or style sheets were removed, for the sender. */
  fonts: string[];
};
type Sink = { destinations: Set<string>; unsupported: string[]; removed: string[]; changes: number; tags: Set<string>; fonts: string[]; policy: FontPolicy; css: Map<string, ReturnType<typeof hostedDeclarations>> };
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
      if (inner.changes || ambiguous.has(comment)) { remove(node, `Outlook conditional comments holding markup Hosted sending removes (${inner.removed.slice(0, 3).join('; ') || 'a repeated attribute'})`); continue; }
      for (const target of inner.destinations) sink.destinations.add(target);
      for (const what of inner.unsupported) note(sink.unsupported, what);
      continue;
    }
    if (node.nodeName === '#text') {
      const text = node as DefaultTreeAdapterMap['textNode'];
      if (BIDI_CONTROLS.test(text.value)) { sink.changes++; note(sink.removed, 'bidi control characters'); if (!frozen) text.value = screenedText(text.value); }
      continue;
    }
    if (!('tagName' in node)) continue;
    const element = node as Element, tag = element.tagName.toLowerCase();
    sink.tags.add(tag);
    if (element.namespaceURI !== HTML || REMOVED_WITH_CONTENT.has(tag)) { remove(node, `${known(tag)} elements, with their content`); continue; }
    if (tag === 'base') { note(sink.unsupported, '<base>'); remove(node); continue; }
    if (tag === 'meta' && !meta(element)) { remove(node, 'meta elements other than charset or viewport'); continue; }
    if (!ELEMENTS.has(tag)) {
      // Its content takes its place.
      sanitize(element, sink, frozen, placeholders, ambiguous);
      if (tag === 'link' && /(?:^|\s)stylesheet(?:\s|$)/i.test(element.attrs.find(a => a.name === 'rel')?.value ?? '')) {
        const href = resource(element.attrs.find(a => a.name === 'href')?.value ?? '');
        if (href && !sink.policy.sheet(href)) foreign(sink, new URL(href).host);
      }
      sink.changes++; note(sink.removed, element.childNodes.length ? `${known(tag)} elements (their content stays)` : `${known(tag)} elements`);
      if (!frozen) { children.splice(children.indexOf(node), 1, ...element.childNodes); for (const child of element.childNodes) child.parentNode = parent as Parent; }
      continue;
    }
    attributes(element, tag, sink, frozen, placeholders);
    if (tag === 'style') {
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
    sanitize(element, sink, frozen, placeholders, ambiguous);
  }
}
const foreign = (sink: Sink, host: string) => { if (!sink.fonts.includes(host)) sink.fonts.push(host); note(sink.removed, `Custom font from ${host} removed`); };
function attributes(element: Element, tag: string, sink: Sink, frozen: boolean, placeholders: boolean) {
  const drop = (attribute: { name: string }, what: string) => {
    sink.changes++; note(sink.removed, what);
    if (!frozen) element.attrs = element.attrs.filter(a => a !== attribute);
  };
  for (const a of [...element.attrs]) {
    const name = (a.prefix ? `${a.prefix}:${a.name}` : a.name).toLowerCase(), value = a.value;
    if (!allowed(tag, name, value)) {
      // A list's type, start or value has its markers drawn as letters or numbers the sender picks.
      const marker = /^(?:ol|ul|li)$/.test(tag) && ((name === 'type' && !/^(?:1|disc|circle|square)$/i.test(value.trim())) || (name === 'start' && !/^\+?0*1$/.test(value.trim())) || name === 'value');
      drop(a, marker ? 'List style changed to plain numbers or bullets' : `${known(name)} attributes on ${known(tag)}`);
      continue;
    }
    if (name === 'style') {
      const read = declarations(sink, value);
      for (const target of read.destinations) sink.destinations.add(target);
      if (read.removed.length) { sink.changes++; for (const what of read.removed) note(sink.removed, what); }
      if (!frozen && read.css !== value) { sink.changes++; if (/[^\s;]/.test(read.css)) a.value = read.css; else element.attrs = element.attrs.filter(b => b !== a); }
      continue;
    }
    if (name === 'alt') {
      if (BIDI_CONTROLS.test(value)) { sink.changes++; note(sink.removed, 'bidi control characters'); if (!frozen) a.value = screenedText(value); }
      continue;
    }
    if (name !== 'href' && name !== 'src') continue;
    if (placeholders && /^[\x00-\x20]*\{\{/.test(value)) continue;
    // A fragment or an empty value stays in the message; cid: names one of its attachments.
    if (/^[\x00-\x20]*(?:#|$)/.test(value) || /^[\x00-\x20]*cid:/i.test(value)) continue;
    if (/^[\x00-\x20]*data:/i.test(value)) { drop(a, `an inline data: address in ${tag} ${name}`); continue; }
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
/** How a body is read: whether addresses may start with a placeholder, where fonts may come from, and whether it is
 *  delivered as submitted (`original`) rather than as its canonical copy. */
export type HostedOptions = { placeholders?: boolean; fonts?: FontSources; original?: boolean };
/**
 * The canonical copy of an HTML body, or null when it is over the parser's budgets or doesn't read as itself after a
 * few passes. With `placeholders`, a campaign's own copy may start an address with a placeholder; each recipient's copy
 * is read without it. Mail delivered as submitted (BYO `screen: true`, `original`) is read by the same rules but not
 * changed: `html` is the submission, `root` the tree a client parses from it, and `removed` what the canonical copy
 * would remove, which such mail must not have to be screened.
 */
export function hostedHtml(html: string, { placeholders = false, fonts = { hosts: DEFAULT_FONT_HOSTS }, original = false }: HostedOptions = {}): HostedHtml | null {
  const policy = fontPolicy(fonts);
  let input = html, read = pass(input, placeholders, policy);
  if (!read) return null;
  // What the first pass found: later passes read a copy without it (a removed <base> is still refused).
  const { removed, tags, fonts: foreignFonts, unsupported } = read;
  if (original) return { html, root: read.root as Document, destinations: read.destinations, unsupported, removed, tags, fonts: foreignFonts };
  for (let i = 0; i < 3 && (read.changes || read.html !== input); i++) {
    input = read.html;
    read = pass(input, placeholders, policy);
    if (!read) return null;
  }
  if (read.changes || read.html !== input) return null;
  return { html: read.html, root: read.root as Document, destinations: read.destinations, unsupported, removed, tags, fonts: foreignFonts };
}
