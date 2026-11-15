/**
 * The style sheets and style attributes of a Hosted message as it is delivered and screened. CSS is never rewritten:
 * the text a sender wrote is kept byte for byte, and only whole declarations and rules are removed, at the ranges the
 * shared CSS Syntax 3 tokenizer (src/css-syntax.ts) found them. What stays is a conservative allow-list:
 *
 * - A declaration stays when its property is a presentation property (PROPERTIES: typography, colour, spacing, sizing,
 *   borders, display and flex/grid layout, alignment, visibility basics) and its value holds only keywords, numbers,
 *   colours, gradients and arithmetic. Custom properties (--*), and any value with var(), env(), attr(), url(),
 *   image-set(), cross-fade(), element(), expression() or another function not on VALUE_FUNCTIONS, or a function name
 *   written with escapes, are removed. Strings stay only where they name fonts or grid areas, never where they draw.
 * - background-image may load one absolute https url("…"), with no escapes, which is listed for the screen.
 * - At-rules: @media stays (its rules filtered the same way); @font-face and @import stay only when they load from the
 *   font services in FontPolicy; every other at-rule (@supports, @keyframes, @counter-style, @page …) is removed.
 * - Every version shows: what hides or shows content is removed wherever it is (hides), and by condition (in @media, or
 *   in a rule a mail client's own markup completes: Selectors) only sizes, spacing, type, colour and display:block stay
 *   (CONDITIONAL). What draws text in another order than the document's is removed everywhere.
 * - A rule stays only with a selector this reader understands and a block of plain declarations: nested rules or
 *   at-rules in a block remove the whole rule. A rule left without declarations is removed.
 *
 * Removing whole declarations and rules from where they were parsed leaves the rest of the text to read as it did.
 */
import { Limit, tokenize, type Token } from './css-syntax.js';

/** Where a sheet may load fonts (an @font-face's files) and other sheets (@import) from: a font can draw any
 *  text and a sheet can generate it, and the screen reads neither. */
export type FontPolicy = { font: (target: string) => boolean; sheet: (target: string) => boolean };
/** The absolute https address a CSS resource leads to, or null. */
export type Resolve = (value: string) => string | null;
/** A sheet or style attribute as delivered: the kept text, what it loads, what was removed and why, and the hosts whose
 *  fonts or sheets were removed. */
export type HostedCss = { css: string; destinations: string[]; removed: string[]; fonts: string[]; changed: boolean;
  /** Whether it removed something that hides or shows content, or changes layout by screen, colour scheme or client. */
  versions: boolean };

// The presentation properties a Hosted message keeps, unprefixed (-webkit-, -moz-, -ms- and -o- variants count too).
// Left out on purpose: content, quotes, counters and anything else that draws text; cursor, filter, mask, clip-path,
// list-style-image and anything else that loads; transform, direction, unicode-bidi, writing-mode, order and grid
// placement, which draw text in another order than the document's; transitions and animations.
export const PROPERTIES = new Set([
  // Typography
  'font', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant', 'font-variant-caps', 'font-variant-numeric', 'font-variant-ligatures',
  'font-feature-settings', 'font-variation-settings', 'font-stretch', 'font-kerning', 'font-optical-sizing', 'font-synthesis', 'font-size-adjust', 'line-height',
  'letter-spacing', 'word-spacing', 'text-align', 'text-align-last', 'text-decoration', 'text-decoration-line', 'text-decoration-color', 'text-decoration-style',
  'text-decoration-thickness', 'text-underline-offset', 'text-underline-position', 'text-transform', 'text-indent', 'text-shadow', 'text-rendering', 'text-size-adjust',
  'white-space', 'word-break', 'word-wrap', 'overflow-wrap', 'hyphens', 'tab-size', 'vertical-align', 'list-style', 'list-style-type', 'list-style-position',
  '-ms-interpolation-mode', 'interpolation-mode', 'font-smoothing', 'osx-font-smoothing',
  // Colour
  'color', 'background', 'background-color', 'background-image', 'background-position', 'background-size', 'background-repeat', 'background-clip',
  'background-origin', 'opacity', 'color-scheme', 'supported-color-schemes', 'accent-color', 'caret-color', 'text-fill-color',
  // Spacing
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-block', 'margin-inline', 'margin-block-start', 'margin-block-end',
  'margin-inline-start', 'margin-inline-end', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-block', 'padding-inline',
  'padding-block-start', 'padding-block-end', 'padding-inline-start', 'padding-inline-end', 'gap', 'row-gap', 'column-gap', 'grid-gap', 'grid-row-gap', 'grid-column-gap',
  // Sizing
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'inline-size', 'block-size', 'min-inline-size', 'max-inline-size', 'min-block-size',
  'max-block-size', 'box-sizing', 'aspect-ratio', 'object-fit', 'object-position',
  // Borders
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-width', 'border-style', 'border-color', 'border-top-width', 'border-right-width',
  'border-bottom-width', 'border-left-width', 'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style', 'border-top-color',
  'border-right-color', 'border-bottom-color', 'border-left-color', 'border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius',
  'border-bottom-right-radius', 'border-collapse', 'border-spacing', 'outline', 'outline-width', 'outline-style', 'outline-color', 'outline-offset', 'box-shadow',
  // Display and layout
  'display', 'float', 'clear', 'overflow', 'overflow-x', 'overflow-y', 'table-layout',
  'caption-side', 'empty-cells', 'flex', 'flex-direction', 'flex-wrap', 'flex-flow', 'flex-grow', 'flex-shrink', 'flex-basis', 'grid-template-columns',
  'grid-template-rows', 'grid-auto-columns', 'grid-auto-rows', 'columns', 'column-count', 'column-width', 'column-rule',
  // Alignment
  'align-items', 'align-content', 'align-self', 'justify-content', 'justify-items', 'justify-self', 'place-items', 'place-content', 'place-self',
  // Visibility basics
  'visibility',
]);
// Outlook's own properties that email templates use for layout, and VML's (a bulletproof button's v-text-anchor).
const MSO = new Set(['mso-table-lspace', 'mso-table-rspace', 'mso-line-height-rule', 'mso-line-height-alt', 'mso-hide', 'mso-padding-alt', 'mso-margin-top-alt',
  'mso-margin-bottom-alt', 'mso-text-raise', 'mso-font-width', 'mso-ansi-font-size', 'mso-bidi-font-size', 'mso-height-rule', 'mso-border-alt',
  'mso-width-percent', 'mso-fit-shape-to-text', 'mso-wrap-style', 'v-text-anchor']);
// The list markers a client may draw: bullets, or 1, 2, 3… (and the CSS-wide keywords, which can only inherit these).
const CSS_WIDE = ['inherit', 'initial', 'unset', 'revert', 'revert-layer'];
const LIST_STYLE_TYPES = new Set(['none', 'disc', 'circle', 'square', 'decimal', ...CSS_WIDE]);
const LIST_STYLE = new Set([...LIST_STYLE_TYPES, 'inside', 'outside']);
// Strings name things in these properties; anywhere else a string could be drawn.
const STRINGS = new Set(['font', 'font-family', 'font-feature-settings', 'font-variation-settings']);
// Functions a kept value may use: colours, gradients, arithmetic and the layout helpers that take only numbers.
const VALUE_FUNCTIONS = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|(?:-webkit-|-moz-|-o-|-ms-)?(?:repeating-)?(?:linear|radial|conic)-gradient|calc|-webkit-calc|min|max|clamp|minmax|repeat|fit-content)$/;
const FONT_DESCRIPTORS = new Set(['font-family', 'src', 'font-style', 'font-weight', 'font-stretch', 'font-display', 'unicode-range', 'font-variant', 'font-feature-settings',
  'font-variation-settings', 'ascent-override', 'descent-override', 'line-gap-override', 'size-adjust']);
const FONT_FUNCTIONS = /^(?:format|tech|local)$/;

// ----- Component values with their source ranges ----------------------------------------------------------------------

type CV = { kind: 'token'; t: Token; start: number; end: number } | { kind: 'block'; open: '{' | '[' | '('; items: CV[]; start: number; end: number }
  | { kind: 'fn'; name: string; escaped: boolean; items: CV[]; start: number; end: number };
const MAX_DEPTH = 24;
function values(tokens: Token[], length: number): CV[] {
  let i = 0;
  const close = { '{': '}', '[': ']', '(': ')' } as const;
  const list = (end: string | null, depth: number): [CV[], number] => {
    if (depth > MAX_DEPTH) throw new Limit();
    const items: CV[] = [];
    while (i < tokens.length) {
      const t = tokens[i++]!;
      if (end && t.kind === end) return [items, t.end];
      if (t.kind === '{' || t.kind === '[' || t.kind === '(') { const [inner, stop] = list(close[t.kind], depth + 1); items.push({ kind: 'block', open: t.kind, items: inner, start: t.at, end: stop }); }
      else if (t.kind === 'function') { const [inner, stop] = list(')', depth + 1); items.push({ kind: 'fn', name: t.value, escaped: t.escaped, items: inner, start: t.at, end: stop }); }
      else items.push({ kind: 'token', t, start: t.at, end: t.end });
    }
    return [items, length];
  };
  return list(null, 0)[0];
}
const ws = (n: CV | undefined) => n?.kind === 'token' && n.t.kind === 'ws';
const tok = (n: CV | undefined, kind: Token['kind']) => n?.kind === 'token' && n.t.kind === kind;
const solid = (items: CV[]) => items.filter(n => !ws(n));

type Item = { kind: 'rule'; prelude: CV[]; block: CV | null; start: number; end: number } | { kind: 'at'; name: string; escaped: boolean; prelude: CV[]; block: CV | null; start: number; end: number };
// A list of rules as CSS Syntax 3 reads one: at-rules end at ; or their block, qualified rules at their block.
function rules(items: CV[], top: boolean): Item[] {
  const out: Item[] = [];
  for (let k = 0; k < items.length;) {
    const n = items[k]!;
    if (ws(n) || (top && (tok(n, 'cdo') || tok(n, 'cdc')))) { k++; continue; }
    const at = n.kind === 'token' && n.t.kind === 'at' ? n.t : null, prelude: CV[] = [];
    let block: CV | null = null, end = n.end;
    for (k += at ? 1 : 0; k < items.length; k++) {
      const m = items[k]!;
      if (at && tok(m, ';')) { end = m.end; k++; break; }
      if (m.kind === 'block' && m.open === '{') { block = m; end = m.end; k++; break; }
      prelude.push(m); end = m.end;
    }
    out.push(at ? { kind: 'at', name: at.value.toLowerCase(), escaped: at.escaped, prelude, block, start: n.start, end } : { kind: 'rule', prelude, block, start: n.start, end });
  }
  return out;
}
type Segment = { items: CV[]; start: number; end: number };
// A block's contents split at its top-level semicolons, each from its first token to its semicolon.
function segments(items: CV[]): Segment[] {
  const out: Segment[] = [];
  let current: CV[] = [];
  const flush = (end?: number) => { const first = current.findIndex(n => !ws(n)); if (first >= 0) { const kept = current.slice(first), last = solid(kept).at(-1)!; out.push({ items: kept, start: kept[0]!.start, end: end ?? last.end }); } current = []; };
  for (const n of items) { if (tok(n, ';')) flush(n.end); else current.push(n); }
  flush();
  return out;
}
// A plain declaration: name, colon, value, with no block in it.
function declaration(segment: Segment): { name: Token; value: CV[] } | null {
  const [head, ...rest] = segment.items;
  if (head?.kind !== 'token' || head.t.kind !== 'ident') return null;
  const colon = rest.findIndex(n => !ws(n));
  if (!tok(rest[colon], ':')) return null;
  const value = rest.slice(colon + 1);
  return value.some(n => n.kind === 'block' && n.open === '{') ? null : { name: head.t, value };
}

// ----- What may stay ---------------------------------------------------------------------------------------------------

/** What a sheet's reader knows of the document a sheet styles (src/hosted-html.ts): whether the screen's style reader
 *  (src/screened-html.ts) applies a selector (`modeled`), and whether a selector applies by condition, a mail client's
 *  own markup completing it (`conditional`, as Gmail's `u + .body .x`). */
export type Selectors = { modeled: (selector: string) => boolean; conditional: (selector: string) => boolean };
const ANY: Selectors = { modeled: () => true, conditional: () => false };
// `inline`: a style attribute rather than a sheet; `selector` and `media`: the rule being read and the @media queries
// around it; `clips`: whether the declaration block being read hides what overflows its box; `blank`: a style
// attribute on an element that holds no text or image, which hiding hides nothing of; `versions`: whether
// anything that hides, shows or changes layout by condition was removed.
type Read = { text: string; resolve: Resolve; policy: FontPolicy; destinations: string[]; removed: string[]; fonts: string[]; inline: boolean; selectors: Selectors;
  selector: string; media: string[]; clips: boolean; blank: boolean; versions: boolean };
const raw = (read: Read, n: { start: number; end: number }) => read.text.slice(n.start, n.end);
function foreign(read: Read, target: string) {
  const host = new URL(target).host;
  if (!read.fonts.includes(host)) { read.fonts.push(host); read.removed.push(`Custom font from ${host} removed`); }
}
/** A value made only of keywords, numbers, colours, gradients and arithmetic (strings where they name things). */
function plainValue(items: CV[], strings: boolean): boolean {
  return items.every(n => {
    if (n.kind === 'fn') return !n.escaped && VALUE_FUNCTIONS.test(n.name) && plainValue(n.items, false);
    if (n.kind === 'block') return n.open !== '{' && plainValue(n.items, false);
    switch (n.t.kind) {
      case 'ws': case 'ident': case 'number': case 'percentage': case 'dimension': case 'hash': case ',': return true;
      case 'string': return strings && !n.t.escaped;
      case 'delim': return '!+-*/.%?'.includes(n.t.value);
      default: return false;
    }
  });
}
// The address in url("…"), url('…') or url(…), written without escapes.
function address(read: Read, n: CV | undefined): string | null {
  if (!n || raw(read, n).includes('\\')) return null;
  if (n.kind === 'token' && n.t.kind === 'url') return n.t.value;
  const inside = n.kind === 'fn' && n.name === 'url' && !n.escaped ? solid(n.items) : [];
  return inside.length === 1 && inside[0]!.kind === 'token' && inside[0]!.t.kind === 'string' ? inside[0]!.t.value : null;
}
const withoutImportant = (items: CV[]) => {
  const s = solid(items), last = s.at(-1), bang = s.at(-2);
  return last?.kind === 'token' && last.t.kind === 'ident' && last.t.value.toLowerCase() === 'important' && bang?.kind === 'token' && bang.t.kind === 'delim' && bang.t.value === '!' ? s.slice(0, -2) : s;
};
function keep(read: Read, d: { name: Token; value: CV[] }, context: 'style' | 'font-face'): string | null {
  const name = d.name.value.toLowerCase(), base = name.replace(/^-(?:webkit|moz|ms|o)-/, '');
  if (d.name.escaped || name.startsWith('--')) return `CSS ${name}`;
  if (context === 'font-face') {
    if (!FONT_DESCRIPTORS.has(name)) return `CSS ${name} in @font-face`;
    if (name !== 'src') return plainValue(d.value, true) ? null : `CSS ${name} in @font-face`;
    // src: url(…) [format(…)] [tech(…)] or local(…), comma-separated, from font services only.
    const found: string[] = [];
    let part: CV[] = [];
    const parts: CV[][] = [];
    for (const n of withoutImportant(d.value)) { if (tok(n, ',')) { parts.push(part); part = []; } else part.push(n); }
    parts.push(part);
    for (const [head, ...rest] of parts) {
      if (head?.kind === 'fn' && head.name === 'local' && !head.escaped && rest.length === 0 && plainValue(head.items, true)) continue;
      const value = address(read, head), target = value === null ? null : read.resolve(value.trim());
      if (target && !read.policy.font(target)) { foreign(read, target); return `a font from ${new URL(target).host}`; }
      if (!target || !rest.every(n => n.kind === 'fn' && !n.escaped && FONT_FUNCTIONS.test(n.name) && n.name !== 'local' && plainValue(n.items, true))) return 'an @font-face src that is not an https font file';
      found.push(target);
    }
    read.destinations.push(...found);
    return null;
  }
  if (!PROPERTIES.has(base) && !MSO.has(name)) return `CSS ${name}`;
  if (base === 'background-image' && d.value.some(n => n.kind === 'fn' || (n.kind === 'token' && n.t.kind === 'url'))) {
    // One absolute https image, as url("…"), and nothing else.
    const value = withoutImportant(d.value), target = value.length === 1 ? address(read, value[0]) : null, url = target === null ? null : read.resolve(target.trim());
    if (!url || !url.startsWith('https://')) return 'a background-image other than one https url("…")';
    read.destinations.push(url);
    return null;
  }
  if (base === 'list-style-type' || base === 'list-style') {
    // List markers only as bullets or 1, 2, 3…: letters and roman numerals spell words the screen never reads.
    const words = withoutImportant(d.value), allowed = base === 'list-style' ? LIST_STYLE : LIST_STYLE_TYPES;
    if (words.length && words.every(n => n.kind === 'token' && n.t.kind === 'ident' && allowed.has(n.t.value.toLowerCase()))) return null;
    return 'List style changed to plain numbers or bullets';
  }
  if (!plainValue(d.value, STRINGS.has(base))) return `CSS ${name} with a value Hosted sending doesn't keep`;
  const words = withoutImportant(d.value), idents = words.flatMap(n => n.kind === 'token' && n.t.kind === 'ident' ? [n.t.value.toLowerCase()] : []);
  const sizes = words.flatMap(n => n.kind === 'token' ? [size(n.t)] : []).filter(n => !Number.isNaN(n));
  // Every version of the message shows at once: what hides or shows content is removed wherever it is, and so is what
  // changes it by condition (in @media, or in a rule a mail client's own markup completes) beyond sizes, spacing, type
  // and colour.
  const conditional = read.media.length > 0 || (!read.inline && read.selectors.conditional(read.selector));
  if (!read.blank && hides(base, words, idents, sizes, read, conditional)) { read.versions = true; return 'CSS that hides or shows content'; }
  // By condition, display:block alone stays (columns stacked on a phone): it only puts content on lines of its own, in
  // document order, so the screen, which reads the layout without conditions, reads it together or apart at most.
  if (conditional && !CONDITIONAL.has(base) && !(base === 'display' && idents.length === 1 && idents[0] === 'block')) { read.versions = true; return 'CSS that changes layout by screen, colour scheme or mail client'; }
  // What draws text in another order than the document's.
  if (base === 'display' && idents.some(v => v === 'contents' || /^table-(?:header-group|footer-group|caption)$/.test(v))) return 'CSS that reorders text';
  if (base === 'float' && idents.some(v => v !== 'none')) return 'CSS that reorders text';
  if (/^(?:flex-direction|flex-flow|flex-wrap)$/.test(base) && idents.some(v => v.endsWith('reverse'))) return 'CSS that reorders text';
  if ((/^margin/.test(base) || base === 'text-indent') && sizes.some(n => n < 0)) return 'CSS that reorders text';
  if ((base === 'letter-spacing' || base === 'word-spacing') && sizes.some(n => n < -2)) return 'CSS that reorders text';
  if (base === 'mso-hide') return 'CSS mso-hide (Outlook shows it too)';
  // What the screen reads to tell whether text can be seen must be in a rule its style reader applies, written plainly.
  if (VISIBLE.has(base) && (!read.inline && !read.selectors.modeled(read.selector) || raw(read, { start: d.value[0]?.start ?? 0, end: d.value.at(-1)?.end ?? 0 }).includes('\\'))) return `CSS ${base} in a rule Hosted sending can't check`;
  return null;
}
// What may change by condition: sizes, spacing, borders, type and colour.
const CONDITIONAL = new Set(['width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'inline-size', 'block-size', 'min-inline-size', 'max-inline-size',
  'min-block-size', 'max-block-size', 'box-sizing', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-block', 'padding-inline',
  'padding-block-start', 'padding-block-end', 'padding-inline-start', 'padding-inline-end', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'margin-block', 'margin-inline', 'margin-block-start', 'margin-block-end', 'margin-inline-start', 'margin-inline-end', 'border', 'border-top', 'border-right',
  'border-bottom', 'border-left', 'border-width', 'border-style', 'border-color', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius', 'border-collapse', 'border-spacing',
  'outline', 'outline-width', 'outline-style', 'outline-color', 'outline-offset', 'box-shadow', 'font', 'font-family', 'font-size', 'font-style', 'font-weight',
  'font-variant', 'font-variant-caps', 'font-variant-numeric', 'font-variant-ligatures', 'font-feature-settings', 'font-variation-settings', 'font-stretch',
  'font-kerning', 'font-optical-sizing', 'font-synthesis', 'font-size-adjust', 'font-smoothing', 'osx-font-smoothing', 'line-height', 'letter-spacing',
  'word-spacing', 'text-align', 'text-align-last', 'text-decoration', 'text-decoration-line', 'text-decoration-color', 'text-decoration-style',
  'text-decoration-thickness', 'text-underline-offset', 'text-underline-position', 'text-transform', 'text-shadow', 'text-rendering', 'text-size-adjust', 'color',
  'background', 'background-color', 'background-image', 'background-position', 'background-size', 'background-repeat', 'background-clip', 'background-origin',
  'color-scheme', 'supported-color-schemes', 'accent-color', 'caret-color', 'text-fill-color']);
// What the screen's style reader reads to tell whether text can be seen (src/screened-html.ts concealed).
const VISIBLE = new Set(['display', 'opacity', 'overflow', 'overflow-x', 'overflow-y', 'width', 'max-width', 'height', 'max-height', 'font', 'font-size',
  'line-height', 'color', 'background', 'background-color', 'background-image', 'text-fill-color']);
// A length, roughly in px (16 px type, a 390 px wide screen); NaN for anything that isn't one. Percentages count against
// 16 px, which is what they are for font-size and line-height.
function size(t: Token): number {
  if (t.kind === 'number') return t.num * (t.num === 0 ? 0 : 16);
  if (t.kind === 'percentage') return t.num * 0.16;
  if (t.kind !== 'dimension') return NaN;
  const unit = t.unit.toLowerCase();
  const factor = ({ px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 37.8, mm: 3.78, q: 0.945, em: 16, rem: 16, ex: 8, ch: 8, lh: 16, rlh: 16 } as Record<string, number>)[unit]
    ?? (/^[sld]?v(?:w|h|i|b|min|max)$/.test(unit) ? 3.9 : NaN);
  return t.num * factor;
}
// What hides or shows content: display:none, any visibility, opacity of 0.1 or less, type or a line height under 2 px, a box
// 2 px or less across in a block that hides its overflow (or by condition, where another rule may hide it), and a colour
// or text fill without opacity.
function hides(base: string, words: CV[], idents: string[], sizes: number[], read: Read, conditional: boolean): boolean {
  switch (base) {
    case 'display': return idents.includes('none');
    case 'visibility': return true;
    case 'opacity': return words.some(n => n.kind === 'token' && ((n.t.kind === 'number' && n.t.num <= 0.1) || (n.t.kind === 'percentage' && n.t.num <= 10)));
    case 'font-size': case 'line-height': return sizes.some(n => n < 2);
    case 'font': {
      // The size is the first length, the line height the one after a slash.
      const lengths = words.filter(n => n.kind === 'token' && ['dimension', 'percentage', 'number'].includes(n.t.kind) && !(n.t.kind === 'number' && n.t.num >= 100));
      return lengths.some(n => n.kind === 'token' && size(n.t) < 2);
    }
    case 'height': case 'max-height': case 'width': case 'max-width': case 'block-size': case 'max-block-size': case 'inline-size': case 'max-inline-size':
      return (read.clips || conditional) && sizes.some(n => n <= 2);
    case 'color': case 'text-fill-color': return transparent(raw(read, { start: words[0]?.start ?? 0, end: words.at(-1)?.end ?? 0 }));
    default: return false;
  }
}
// transparent, or a colour with alpha of 0.1 or less.
function transparent(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return true;
  const hex = /^#[0-9a-f]{8}$/.exec(v) ? parseInt(v.slice(7), 16) / 255 : /^#[0-9a-f]{4}$/.exec(v) ? parseInt(v[4]! + v[4], 16) / 255 : undefined;
  if (hex !== undefined) return hex <= 0.1;
  const inner = /^(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)a?\((.*)\)$/s.exec(v)?.[1];
  if (!inner) return false;
  const slash = inner.split('/'), commas = inner.split(',');
  const alpha = slash.length === 2 ? slash[1]!.trim() : commas.length === 4 ? commas[3]!.trim() : undefined;
  if (!alpha) return false;
  const n = alpha.endsWith('%') ? parseFloat(alpha) / 100 : parseFloat(alpha);
  return Number.isFinite(n) && n <= 0.1;
}
type Range = { start: number; end: number };
// A block of plain declarations: the ranges to remove, or null when the block holds anything else (nested rules).
function declarations(read: Read, items: CV[], context: 'style' | 'font-face', inline: boolean): { removals: Range[]; kept: number } | null {
  const removals: Range[] = [];
  read.inline = inline;
  // Whether the block hides what overflows its box, which a tiny width or height then hides.
  read.clips = segments(items).some(segment => { const d = declaration(segment); return !!d && /^overflow(?:-[xy])?$/i.test(d.name.value) && withoutImportant(d.value).some(n => n.kind === 'token' && n.t.kind === 'ident' && /^(?:hidden|clip)$/i.test(n.t.value)); });
  let kept = 0;
  for (const segment of segments(items)) {
    const d = declaration(segment);
    if (!d) {
      if (!inline && segment.items.some(n => (n.kind === 'block' && n.open === '{') || tok(n, 'at'))) return null;
      read.removed.push('CSS that is not a declaration'); removals.push(segment); continue;
    }
    const why = keep(read, d, context);
    if (why) { read.removed.push(why); removals.push(segment); } else kept++;
  }
  return { removals, kept };
}
// Selectors as written: type, class, id, attribute and pseudo selectors and combinators. Anything else (a function this
// reader doesn't know, an address, a block, a type selector run into another) drops the rule.
const PSEUDO_FUNCTIONS = /^(?:not|is|where|matches|-webkit-any|-moz-any|nth-child|nth-last-child|nth-of-type|nth-last-of-type|lang|dir)$/;
function selector(items: CV[], argument = false): boolean {
  let joinable = false; // the previous token ends a compound that an ident or hash would run into
  for (const n of items) {
    if (n.kind === 'fn') { if (n.escaped || !PSEUDO_FUNCTIONS.test(n.name) || !selector(n.items, true)) return false; joinable = false; continue; }
    if (n.kind === 'block') {
      if (n.open !== '[' || !n.items.every(m => m.kind === 'token' && ['ws', 'ident', 'string', 'delim'].includes(m.t.kind) && (m.t.kind !== 'delim' || '=~|^$*'.includes(m.t.value)))) return false;
      joinable = true; continue;
    }
    switch (n.t.kind) {
      case 'ws': case ',': joinable = false; break;
      case ':': joinable = false; break;
      case 'ident': case 'hash': if (joinable) return false; joinable = true; break;
      case 'number': case 'dimension': if (!argument) return false; joinable = true; break; // An+B arguments
      case 'delim': if (!'.*>+~|'.includes(n.t.value) && !(argument && n.t.value === '-')) return false; joinable = false; break;
      default: return false;
    }
  }
  return items.some(n => !ws(n));
}
// Media queries: keywords, features in parentheses, numbers and comparisons.
function media(items: CV[]): boolean {
  return items.every(n => n.kind === 'block' ? n.open === '(' && media(n.items)
    : n.kind === 'token' && (['ws', 'ident', 'number', 'dimension', 'percentage', ':', ','].includes(n.t.kind) || (n.t.kind === 'delim' && '<>=/'.includes(n.t.value))));
}
function sheet(read: Read, items: Item[], top: boolean): { removals: Range[]; kept: number } {
  const removals: Range[] = [];
  let kept = 0;
  const drop = (item: Item, why: string) => { read.removed.push(why); removals.push(item); };
  for (const item of items) {
    if (item.kind === 'rule') {
      if (!item.block || !selector(item.prelude)) { drop(item, 'a CSS rule with a selector Hosted sending does not read'); continue; }
      read.selector = raw(read, { start: item.start, end: item.block.start });
      const inner = declarations(read, (item.block as Extract<CV, { kind: 'block' }>).items, 'style', false);
      if (!inner) { drop(item, 'a CSS rule with nested rules'); continue; }
      if (!inner.kept) { removals.push(item); continue; }
      removals.push(...inner.removals); kept++;
      continue;
    }
    const block = item.block as Extract<CV, { kind: 'block' }> | null;
    if (item.escaped) { drop(item, `CSS @${item.name}`); continue; }
    if (item.name === 'media' && block && media(item.prelude)) {
      read.media.push(raw(read, { start: item.start, end: block.start }).replace(/^@media/i, ''));
      const inner = sheet(read, rules(block.items, false), false);
      read.media.pop();
      if (inner.kept) { removals.push(...inner.removals); kept++; } else removals.push(item);
    } else if (item.name === 'font-face' && block) {
      const inner = declarations(read, block.items, 'font-face', false);
      if (inner?.kept) { removals.push(...inner.removals); kept++; } else drop(item, 'an @font-face Hosted sending does not keep');
    } else if (item.name === 'import' && !block && top) {
      const at = item.prelude.findIndex(n => !ws(n)), value = address(read, item.prelude[at]) ?? (tok(item.prelude[at], 'string') && !raw(read, item.prelude[at]!).includes('\\') ? (item.prelude[at] as { t: Token }).t.value : null);
      const target = value === null ? null : read.resolve(value.trim());
      if (target && !read.policy.sheet(target)) { foreign(read, target); removals.push(item); continue; }
      if (!target || !media(item.prelude.slice(at + 1))) { drop(item, 'an @import that is not an https font service'); continue; }
      read.destinations.push(target); kept++;
    } else drop(item, `CSS @${item.name}`);
  }
  return { removals, kept };
}
function filter(css: string, resolve: Resolve, policy: FontPolicy, as: 'sheet' | 'declarations', selectors: Selectors = ANY, blank = false): HostedCss {
  const text = css.replace(/\r\n?/g, '\n'), read: Read = { text, resolve, policy, destinations: [], removed: [], fonts: [], inline: as === 'declarations', selectors, selector: '', media: [], clips: false, blank, versions: false };
  let removals: Range[];
  try {
    const items = values(tokenize(text), text.length);
    removals = as === 'sheet' ? sheet(read, rules(items, true), true).removals : declarations(read, items, 'style', true)!.removals;
  } catch (error) {
    if (!(error instanceof Limit)) throw error;
    return { css: '', destinations: [], removed: ['a style sheet over the CSS budget'], fonts: [], changed: css !== '', versions: false };
  }
  let out = '', at = 0;
  for (const range of removals.sort((a, b) => a.start - b.start)) { if (range.start < at) continue; out += text.slice(at, range.start); at = range.end; }
  out += text.slice(at);
  return { css: out, destinations: [...new Set(read.destinations)], removed: read.removed, fonts: read.fonts, changed: out !== css, versions: read.versions };
}
/** A <style> sheet as delivered. */
export const hostedSheet = (css: string, resolve: Resolve, policy: FontPolicy, selectors?: Selectors) => filter(css, resolve, policy, 'sheet', selectors);
const NOTHING: FontPolicy = { font: () => false, sheet: () => false };
/** A style attribute as delivered. `blank`: its element holds no text or image, so what would hide it hides nothing and
 *  stays (a spacer's 1 px type, an empty block's display:none). */
export const hostedDeclarations = (css: string, resolve: Resolve, blank = false) => filter(css, resolve, NOTHING, 'declarations', ANY, blank);

/** A declaration as the screen's style reader reads it: the property, its value as written, and !important. */
export type CssDeclaration = { property: string; value: string; important: boolean };
/** A qualified rule: its selector as written, the @media queries around it (outermost first), its declarations. */
export type CssRule = { selector: string; media: string[]; declarations: CssDeclaration[] };
function plain(text: string, items: CV[]): CssDeclaration[] {
  return segments(items).flatMap(segment => {
    const d = declaration(segment);
    if (!d) return [];
    const value = withoutImportant(d.value);
    return [{ property: d.name.value.toLowerCase(), value: value.length ? text.slice(value[0]!.start, value.at(-1)!.end) : '', important: value.length !== solid(d.value).length }];
  });
}
/** A sheet's qualified rules in source order, read with the CSS Syntax 3 tokenizer as clients read them (strings,
 *  comments and escapes included); at-rules other than @media are left out. Empty past the CSS budget. */
export function cssRules(css: string): CssRule[] {
  const text = css.replace(/\r\n?/g, '\n'), out: CssRule[] = [];
  let items: CV[];
  try { items = values(tokenize(text), text.length); } catch (error) { if (error instanceof Limit) return []; throw error; }
  const visit = (list: Item[], media: string[]) => {
    for (const item of list) {
      const block = item.block?.kind === 'block' ? item.block : null;
      if (!block) continue;
      if (item.kind === 'rule') out.push({ selector: text.slice(item.start, block.start).trim(), media, declarations: plain(text, block.items) });
      else if (item.name === 'media' && !item.escaped) visit(rules(block.items, false), [...media, text.slice(item.start, block.start).replace(/^@media/i, '').replace(/\s+/g, ' ').trim().toLowerCase()]);
    }
  };
  visit(rules(items, true), []);
  return out;
}
/** A style attribute's declarations, read with the same tokenizer. */
export function cssDeclarations(css: string): CssDeclaration[] {
  const text = css.replace(/\r\n?/g, '\n');
  try { return plain(text, values(tokenize(text), text.length)); } catch (error) { if (error instanceof Limit) return []; throw error; }
}
