/**
 * The HTML of a Hosted message as it is delivered and screened: one canonical copy. The body is parsed once, as a
 * document, the tree is reduced to an allow-list of elements and attributes, and the result is serialized; that
 * serialization is what goes to SES, and the screen's text, its destination inventory and the verdict key come from the
 * same tree. A duplicate attribute is read and delivered once (the first, as every HTML parser reads it). The copy is
 * read again until it reads as itself, so a client parses exactly what was screened.
 *
 * Kept: the elements in ELEMENTS (document structure, text, links, images, tables, headings, lists and inline
 * formatting), only with the attributes `allowed` names, CSS through its own allow-list (src/hosted-css.ts, which keeps
 * the CSS text as written less whole declarations and rules), and fonts and style sheets only from font services
 * (FontSources). Everything else is removed: an element outside the list gives its place to its content, except the
 * ones a client draws its own text or controls for (form controls, scripts, frames, plugins, SVG, MathML, templates,
 * noscript, details, marquee, ruby, media) and the title, which go with their content; every comment (Outlook's
 * conditional ones included, so every client shows one copy); `dir`; `hidden`; CSS that hides, shows or reorders
 * content, wherever it is, so the copy shows every version of the message at once (`showsAll`: dark-mode and mobile
 * toggles, a preheader); and what its CSS still hides, with its text (conceal). What the screen reads of this tree is
 * the text its body shows, in document order, with each image's alt text in its place (src/screen.ts).
 *
 * Refused (the sender must fix it), because what it leads to depends on where the message is opened: <base>, and any
 * link or image address that is not absolute http(s), mailto, tel, cid: or a #fragment.
 */
import { defaultTreeAdapter, html as spec, serializeOuter, type DefaultTreeAdapterMap } from 'parse5';
import { boundedHtmlFragment } from './bounded-html.js';
import { cssRules, hostedDeclarations, hostedSheet, type FontPolicy } from './hosted-css.js';
import { concealed, documentSelectors, screenedText } from './screened-html.js';

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
// <thead> and <tfoot> aren't: a client draws them first and last wherever they are, so their rows read in place instead.
const ELEMENTS = new Set(['html', 'head', 'body', 'meta', 'style', 'div', 'span', 'p', 'br', 'hr', 'a', 'img', 'table', 'tbody', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'sup', 'sub', 'blockquote', 'pre',
  'code', 'center', 'font']);
// Removed with their content: a client draws text, controls or media of its own for these (or runs or loads them), or,
// for a title, shows nothing of it in the message.
const REMOVED_WITH_CONTENT = new Set(['title', 'script', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'noframes', 'object', 'applet', 'embed', 'param',
  'noembed', 'svg', 'math', 'form', 'input', 'textarea', 'button', 'select', 'option', 'optgroup', 'datalist', 'output', 'meter', 'progress', 'keygen',
  'details', 'summary', 'dialog', 'marquee', 'ruby', 'rt', 'rp', 'rb', 'rtc', 'audio', 'video', 'canvas', 'map', 'area', 'portal']);
// Attributes any kept element may have: none of them is drawn as text or loads anything. Not dir: a right-to-left
// paragraph lays inline boxes out from the right, in another order than the text's, so text keeps its own direction (the
// Unicode bidi algorithm still shows right-to-left scripts right to left).
const PRESENTATION = new Set(['style', 'class', 'id', 'lang', 'role', 'width', 'height', 'align', 'valign', 'bgcolor', 'border', 'cellpadding',
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
// align="right" floats an image or table to the right, where several line up in reverse.
const allowed = (tag: string, name: string, value: string) =>
  (PRESENTATION.has(name) && !(name === 'align' && (tag === 'img' || tag === 'table') && !/^\s*(?:left|center|middle|top|bottom|baseline)\s*$/i.test(value))) || ARIA.has(name) || !!ATTRIBUTES[tag]?.(name, value);
// <meta charset>, the http-equiv form of it, and the viewport: nothing else a <meta> says is kept.
const meta = (element: Element) => {
  const get = (name: string) => element.attrs.find(a => a.name === name)?.value.trim().toLowerCase();
  return get('charset') !== undefined || get('name') === 'viewport' || get('http-equiv') === 'content-type';
};
// What the sender is told was removed names elements and attributes from HTML's vocabulary, never other text of theirs.
const VOCABULARY = new Set([...ELEMENTS, ...REMOVED_WITH_CONTENT, 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside', 'address', 'figure',
  'figcaption', 'picture', 'source', 'track', 'link', 'base', 'col', 'colgroup', 'caption', 'dl', 'dt', 'dd', 'label', 'fieldset', 'legend', 'abbr',
  'acronym', 'cite', 'q', 'dfn', 'kbd', 'samp', 'var', 'mark', 'del', 'ins', 'big', 'strike', 'tt', 'nobr', 'wbr', 'bdi', 'bdo', 'time', 'data', 'xmp',
  'plaintext', 'listing', 'slot', 'menu', 'dir', 'thead', 'tfoot', 'hgroup', 'search', 'xml', 'basefont', 'spacer', 'blink', 'image', 'isindex', 'menuitem', 'title', 'name',
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
// Outlook shows what <!--[if mso]>…<![endif]--> holds and hides what <!--[if !mso]><!-->…<!--<![endif]--> encloses (and
// <![if …]> marks the same): every such comment goes, so every client shows the same copy, the one screened.
const OUTLOOK = /^\[if\b|^<?!?\[endif\]|<!\[endif\]$/i;

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
  /** How the copy's elements lay out where its CSS says (src/screened-html.ts concealed), for reading text in order. */
  layout: Map<Element, 'inline' | 'block'>;
  /** Whether CSS that hides or shows content, or changes layout by screen, colour scheme or mail client, was removed:
   *  the copy shows every version of the message at once. */
  showsAll: boolean;
};
type Sink = { destinations: Set<string>; unsupported: string[]; removed: string[]; changes: number; tags: Set<string>; fonts: string[]; policy: FontPolicy; css: Map<string, ReturnType<typeof hostedDeclarations>>; sheets: Element[]; showsAll: boolean };
// Mail repeats the same inline styles on every row and cell: each distinct one is read once per pass.
const declarations = (sink: Sink, value: string, blank: boolean) => {
  const key = `${blank}\0${value}`;
  let read = sink.css.get(key); if (!read) { read = hostedDeclarations(value, resource, blank); sink.css.set(key, read); }
  return read;
};
// Text a client draws something of: anything but white space and characters drawn as nothing.
const VISIBLE_TEXT = /[^\s\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
/** Whether an element holds no text a client draws and no image, so nothing its style may hide. */
const blank = (element: Element): boolean => element.tagName !== 'img' && element.childNodes.every(child => child.nodeName === '#text' ? !VISIBLE_TEXT.test((child as DefaultTreeAdapterMap['textNode']).value)
  : !('tagName' in child) || blank(child));
const note = (list: string[], what: string) => { if (!list.includes(what) && list.length < 20) list.push(what); };

/** One pass: parse, sanitize, serialize. */
function sanitize(parent: Parent, sink: Sink, placeholders: boolean) {
  const children = parent.childNodes;
  const remove = (node: Node, what?: string) => {
    sink.changes++;
    if (what) note(sink.removed, what);
    children.splice(children.indexOf(node), 1);
  };
  for (const node of [...children]) {
    if (node.nodeName === '#comment') { remove(node, OUTLOOK.test((node as DefaultTreeAdapterMap['commentNode']).data.trim()) ? 'Outlook conditional comments' : undefined); continue; }
    if (node.nodeName === '#text') {
      const text = node as DefaultTreeAdapterMap['textNode'];
      if (BIDI_CONTROLS.test(text.value)) { sink.changes++; note(sink.removed, 'bidi control characters'); text.value = screenedText(text.value); }
      continue;
    }
    if (!('tagName' in node)) continue;
    const element = node as Element, tag = element.tagName.toLowerCase();
    sink.tags.add(tag);
    // A document's title isn't shown in the message, wherever a client shows it: removed, and only named in a body.
    if (tag === 'title' && (parent as Element).tagName === 'head') { remove(node); continue; }
    if (element.namespaceURI !== HTML || REMOVED_WITH_CONTENT.has(tag)) { remove(node, `${known(tag)} elements, with their content`); continue; }
    if (tag === 'base') { note(sink.unsupported, '<base>'); remove(node); continue; }
    if (tag === 'meta' && !meta(element)) { remove(node, 'meta elements other than charset or viewport'); continue; }
    if (!ELEMENTS.has(tag)) {
      // Its content takes its place.
      sanitize(element, sink, placeholders);
      if (tag === 'link' && /(?:^|\s)stylesheet(?:\s|$)/i.test(element.attrs.find(a => a.name === 'rel')?.value ?? '')) {
        const href = resource(element.attrs.find(a => a.name === 'href')?.value ?? '');
        if (href && !sink.policy.sheet(href)) foreign(sink, new URL(href).host);
      }
      sink.changes++; note(sink.removed, element.childNodes.length ? `${known(tag)} elements (their content stays)` : `${known(tag)} elements`);
      children.splice(children.indexOf(node), 1, ...element.childNodes); for (const child of element.childNodes) child.parentNode = parent;
      continue;
    }
    attributes(element, tag, sink, placeholders);
    // Sheets are read once the rest of the document is (styles below), since what they may hide depends on it.
    if (tag === 'style') { sink.sheets.push(element); continue; }
    sanitize(element, sink, placeholders);
  }
}
/**
 * The copy's sheets through the CSS allow-list (src/hosted-css.ts), which keeps nothing that hides or shows content and
 * nothing a screen width, colour scheme or mail client changes but sizes, spacing, type and colour. Which rules apply by
 * a mail client's own markup, and which the screen's style reader applies, is read from the document.
 */
function styles(root: Document, sink: Sink) {
  const html = root.childNodes.find((node): node is Element => 'tagName' in node && node.tagName === 'html');
  if (!html || !sink.sheets.length) return;
  const text = (element: Element) => element.childNodes.map(child => 'value' in child ? child.value : '').join('');
  const selectors = documentSelectors(html, root.mode === 'quirks');
  for (const element of sink.sheets) {
    const css = text(element), read = hostedSheet(css, resource, sink.policy, selectors);
    if (read.removed.length) { sink.changes++; for (const what of read.removed) note(sink.removed, what); }
    if (read.versions) sink.showsAll = true;
    for (const host of read.fonts) if (!sink.fonts.includes(host)) sink.fonts.push(host);
    for (const target of read.destinations) sink.destinations.add(target);
    if (read.css !== css || element.childNodes.some(child => !('value' in child))) {
      sink.changes++;
      if (!read.css.trim()) { const parent = element.parentNode!; parent.childNodes.splice(parent.childNodes.indexOf(element), 1); continue; }
      element.childNodes = [];
      defaultTreeAdapter.insertText(element, read.css);
    }
  }
}
/**
 * What the copy's CSS still hides (src/screened-html.ts concealed: declarations that hide only together, in some
 * reading of its conditions) goes with its text: a hidden element keeps its place but not its content (a hidden image
 * goes), and text drawn in its background colour goes. A hidden element draws nothing, so it doesn't separate the text
 * around it either.
 */
function conceal(root: Document): { layout: Map<Element, 'inline' | 'block'>; removed: string[] } {
  const layout = new Map<Element, 'inline' | 'block'>(), removed: string[] = [];
  const html = root.childNodes.find((node): node is Element => 'tagName' in node && node.tagName === 'html');
  if (!html) return { layout, removed };
  const sheets: string[] = [];
  const collect = (parent: Parent) => { for (const node of parent.childNodes) if ('tagName' in node) { if (node.tagName === 'style') sheets.push(node.childNodes.map(child => 'value' in child ? child.value : '').join('')); else collect(node); } };
  collect(html);
  const { hidden, invisible, inline, block } = concealed(html, sheets.flatMap(cssRules), root.mode === 'quirks');
  for (const element of inline) layout.set(element, 'inline');
  for (const element of block) layout.set(element, 'block');
  const visit = (parent: Parent) => {
    for (const node of [...parent.childNodes]) {
      if (node.nodeName === '#text') {
        if (invisible.has(node as DefaultTreeAdapterMap['textNode'])) { parent.childNodes.splice(parent.childNodes.indexOf(node), 1); note(removed, 'text in its background colour'); }
        continue;
      }
      if (!('tagName' in node) || node.tagName === 'head') continue;
      if (!hidden.has(node)) { visit(node); continue; }
      layout.set(node, 'inline');
      if (node.tagName === 'img') { parent.childNodes.splice(parent.childNodes.indexOf(node), 1); note(removed, 'hidden images'); continue; }
      if (!blank(node)) { node.childNodes = []; note(removed, 'hidden elements, with their content'); }
    }
  };
  visit(html);
  return { layout, removed };
}
const foreign = (sink: Sink, host: string) => { if (!sink.fonts.includes(host)) sink.fonts.push(host); note(sink.removed, `Custom font from ${host} removed`); };
function attributes(element: Element, tag: string, sink: Sink, placeholders: boolean) {
  const drop = (attribute: { name: string }, what: string) => {
    sink.changes++; note(sink.removed, what);
    element.attrs = element.attrs.filter(a => a !== attribute);
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
      const read = declarations(sink, value, blank(element));
      if (read.versions) sink.showsAll = true;
      for (const target of read.destinations) sink.destinations.add(target);
      if (read.removed.length) { sink.changes++; for (const what of read.removed) note(sink.removed, what); }
      if (read.css !== value) { sink.changes++; if (/[^\s;]/.test(read.css)) a.value = read.css; else element.attrs = element.attrs.filter(b => b !== a); }
      continue;
    }
    if (name === 'alt') {
      if (BIDI_CONTROLS.test(value)) { sink.changes++; note(sink.removed, 'bidi control characters'); a.value = screenedText(value); }
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
  const sink: Sink = { destinations: new Set(), unsupported: [], removed: [], changes: 0, tags: new Set(), fonts: [], policy, css: new Map(), sheets: [], showsAll: false };
  // A repeated attribute inside a comment goes with the comment.
  const root = boundedHtmlFragment(html, 'document', { clients: true, onParseError: (error, within) => {
    if (error.code === 'duplicate-attribute' && !within) note(sink.removed, 'a repeated attribute (the first is kept)');
  } });
  if (!root) return null;
  sanitize(root, sink, placeholders);
  styles(root as Document, sink);
  const { layout, removed } = conceal(root as Document);
  if (removed.length) { sink.changes++; for (const what of removed) note(sink.removed, what); }
  // Mail is read without scripting: <noscript> holds markup, written as such.
  const serialized = root.childNodes.map(node => node.nodeName === '#documentType' ? doctype(node as DefaultTreeAdapterMap['documentType']) : serializeOuter(node, { scriptingEnabled: false })).join('');
  return { html: serialized, root, layout, ...sink };
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
  const { removed, tags, fonts: foreignFonts, unsupported, showsAll } = read;
  if (original) return { html, root: read.root as Document, destinations: read.destinations, unsupported, removed, tags, fonts: foreignFonts, layout: read.layout, showsAll };
  for (let i = 0; i < 3 && (read.changes || read.html !== input); i++) {
    input = read.html;
    read = pass(input, placeholders, policy);
    if (!read) return null;
  }
  if (read.changes || read.html !== input) return null;
  return { html: read.html, root: read.root as Document, destinations: read.destinations, unsupported, removed, tags, fonts: foreignFonts, layout: read.layout, showsAll };
}
