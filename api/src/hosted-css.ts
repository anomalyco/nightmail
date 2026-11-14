/**
 * The style sheets and style attributes of a Hosted message as it is delivered and screened. The CSS is read with the
 * shared CSS Syntax 3 layer (src/css-syntax.ts), so comments and escapes are read as every client reads them, and
 * written back from its tokens: what goes out is exactly what was read, and nothing in it was hidden from the screen.
 *
 * - Text a client would draw from CSS is removed: content, quotes, counters, string-set, list markers and text-overflow
 *   or hyphenation strings that are anything but keywords, @counter-style, @page and every other at-rule a mail client
 *   has no use for, and IE's behaviors, bindings, expressions and filters (AlphaImageLoader).
 * - Every resource (url(), image-set(), image(), src(), @import, @font-face src) is a destination: an absolute http(s)
 *   address, listed for the screen; a declaration or rule loading anything else (a relative or data: address) is removed.
 * - Typography, layout, colour, media queries, @supports, @font-face, @import and @keyframes stay as they are.
 */
import { Limit, components, contents, ident, nameText, number, rules, tokenize, type Decl, type Node, type Rule } from './css-syntax.js';

/** What a sheet or style attribute reads as: the CSS to deliver, the destinations it loads, and what was removed. */
export type HostedCss = { css: string; destinations: string[]; removed: string[] };
/** The absolute http(s) address a CSS resource leads to, or null when it may not be loaded. */
export type Resolve = (value: string) => string | null;

// Properties that draw text, or run code in old Internet Explorer and Firefox: always removed.
const TEXT = new Set(['content', 'quotes', 'string-set', 'counter-reset', 'counter-increment', 'counter-set', 'behavior', 'binding']);
// Properties that draw a string when given one: kept only with keywords, numbers, colours and images.
const MARKERS = new Set(['list-style-type', 'list-style', 'text-overflow', 'hyphenate-character', 'text-emphasis-style', 'text-emphasis']);
const PLAIN_FUNCTIONS = /^(?:url|rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|(?:-[a-z]+-)?(?:repeating-)?(?:linear|radial|conic)-gradient)$/;
// Functions whose strings are addresses.
const IMAGES = new Set(['image', 'image-set', '-webkit-image-set', 'cross-fade', '-webkit-cross-fade']);
const GROUPS = new Set(['media', 'supports', 'container', 'layer', 'scope', 'starting-style']);
const KEYFRAMES = /^(?:-[a-z]+-)?keyframes$/;

// ----- Writing tokens back --------------------------------------------------------------------------------------------

const isNameChar = (c: string | undefined) => c !== undefined && (/[a-zA-Z0-9_-]/.test(c) || c.charCodeAt(0) >= 0x80);
type Trail = 'name' | 'number' | 'minus' | 'plus' | 'dot' | 'joins' | 'slash' | 'lt' | 'other';
/** Whether two neighbours written without a space would read as one token (or open a comment or an end tag). */
function joins(trail: Trail, next: string) {
  const c = next[0], d = next[1];
  switch (trail) {
    case 'name': return isNameChar(c) || c === '\\' || c === '(';
    case 'number': return c === '-' ? !(d !== undefined && /[0-9.]/.test(d)) : isNameChar(c) || c === '.' || c === '%' || c === '\\';
    case 'minus': return isNameChar(c) || c === '.' || c === '\\';
    case 'plus': case 'dot': return c !== undefined && /[0-9.]/.test(c);
    case 'joins': return isNameChar(c) || c === '\\';
    case 'slash': return c === '*';
    case 'lt': return true;
    default: return false;
  }
}
class Writer {
  text = '';
  private trail: Trail | null = null;
  private space = false;
  ws() { if (this.trail) this.space = true; }
  push(t: string, trail: Trail) {
    if (this.trail && (this.space || joins(this.trail, t))) this.text += ' ';
    this.space = false;
    this.text += t;
    this.trail = trail;
  }
}
const escaped = (ch: string) => `\\${ch.codePointAt(0)!.toString(16)} `;
// An unquoted url(): quotes, parentheses, spaces, backslashes and control characters escaped, and < and > so it never
// ends a <style> element. & stays as written: some clients' CSS readers don't decode escapes in addresses.
const urlText = (v: string) => `url(${[...v].map(ch => /[\s"'()\\<>\x00-\x1f\x7f]/.test(ch) ? escaped(ch) : ch).join('')})`;
// A string in single quotes (double when it holds a single quote), so a style attribute keeps its quotes as written
// rather than as &quot;.
function quoted(v: string) {
  const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
  return quote + [...v].map(ch => ch === quote || /[\\<>\x00-\x1f\x7f]/.test(ch) ? escaped(ch) : ch).join('') + quote;
}
function write(nodes: Node[], out = new Writer()): Writer {
  for (const n of nodes) {
    switch (n.kind) {
      case 'ws': out.ws(); break;
      case 'ident': out.push(ident(n.value), 'name'); break;
      case 'at': out.push('@' + ident(n.value), 'name'); break;
      case 'hash': out.push('#' + (n.id ? ident(n.value) : nameText(n.value)), 'name'); break;
      case 'string': out.push(quoted(n.value), 'other'); break;
      case 'url': out.push(urlText(n.value), 'other'); break;
      case 'number': out.push(number(n), 'number'); break;
      case 'percentage': out.push(number(n), 'other'); break;
      case 'dimension': out.push(number(n), 'name'); break;
      case 'delim': out.push(n.value, n.value === '-' ? 'minus' : n.value === '+' ? 'plus' : n.value === '.' ? 'dot' : n.value === '/' ? 'slash' : n.value === '<' ? 'lt' : n.value === '#' || n.value === '@' ? 'joins' : 'other'); break;
      case 'fn': out.push(`${ident(n.name)}(${write(n.items).text})`, 'other'); break;
      case 'block': out.push(`${n.open}${write(n.items).text}${({ '(': ')', '[': ']', '{': '}' } as const)[n.open]}`, 'other'); break;
      case 'cdo': case 'cdc': case 'bad': throw new Limit();
      default: out.push(n.kind, 'other');
    }
  }
  return out;
}
// The tokens a list reads as, flattened and without whitespace, to check that writing it back changed nothing.
function flat(nodes: Node[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === 'ws') continue;
    if (n.kind === 'fn') { out.push(`fn:${n.name}`); flat(n.items, out); out.push(')'); }
    else if (n.kind === 'block') { out.push(n.open); flat(n.items, out); out.push('end'); }
    else out.push(`${n.kind}:${n.value}:${n.unit}`);
  }
  return out;
}
/** Writes a list back, or null when the text would read as other tokens. */
function written(nodes: Node[]): string | null {
  let text: string;
  try { text = write(nodes).text; } catch (error) { if (error instanceof Limit) return null; throw error; }
  return flat(components(tokenize(text))).join('\u0000') === flat(nodes).join('\u0000') ? text : null;
}

// ----- Reading -------------------------------------------------------------------------------------------------------

type Read = { resolve: Resolve; destinations: string[]; removed: string[] };
/** The destinations a list of component values loads, or null when it loads one that may not be loaded. */
function resources(nodes: Node[], read: Read, images = false, found: string[] = []): string[] | null {
  const address = (value: string) => {
    const v = value.trim();
    if (v.startsWith('#')) return true; // A reference within the message (an SVG gradient or filter).
    const target = read.resolve(v);
    if (target) found.push(target);
    return !!target;
  };
  for (const n of nodes) {
    if (n.kind === 'bad' || n.kind === 'cdo' || n.kind === 'cdc' || (n.kind === 'delim' && n.value === '\\')) return null;
    if (n.kind === 'url' && !address(n.value)) return null;
    if (n.kind === 'string' && (images ? !address(n.value) : /progid\s*:|alphaimageloader/i.test(n.value))) return null;
    if (n.kind === 'ident' && n.value.toLowerCase() === 'progid') return null;
    if (n.kind === 'fn') {
      if (n.name === 'expression' || n.name === 'alphaimageloader') return null;
      if (n.name === 'url' || n.name === 'src') {
        const parts = n.items.filter(m => m.kind !== 'ws');
        if (parts.length !== 1 || parts[0]!.kind !== 'string' || !address(parts[0]!.value)) return null;
      } else if (!resources(n.items, read, IMAGES.has(n.name), found)) return null;
    }
    if (n.kind === 'block' && !resources(n.items, read, images, found)) return null;
  }
  return found;
}
// A value that can only be keywords, numbers, colours and images: no string, and no var(), env() or attr() anywhere that
// could put one in.
const plain = (n: Node): boolean => n.kind === 'ws' || n.kind === 'ident' || n.kind === 'number' || n.kind === 'percentage' || n.kind === 'dimension'
  || n.kind === 'hash' || n.kind === ',' || n.kind === 'url' || (n.kind === 'fn' && PLAIN_FUNCTIONS.test(n.name) && n.items.every(m => m.kind === 'string' ? n.name === 'url' : m.kind === 'delim' || plain(m)));
/** A declaration as delivered, or null when it is removed. */
function declaration(d: Decl, read: Read): string | null {
  const name = d.name.startsWith('--') ? d.name : d.name.replace(/^-[a-z0-9]+-/, '');
  const drop = (why: string) => { read.removed.push(why); return null; };
  if (TEXT.has(name)) return drop(`CSS ${d.name}`);
  if (MARKERS.has(name) && !d.value.every(plain)) return drop(`CSS ${d.name} with a string`);
  const found = resources(d.value, read);
  if (!found) return drop(`CSS ${d.name} loading a relative or inline address, or running code`);
  const value = written(d.value);
  if (value === null) return drop(`CSS ${d.name} that could not be read back`);
  read.destinations.push(...found);
  return `${ident(d.name)}:${value}${d.important ? '!important' : ''}`;
}
function block(nodes: Node[], read: Read, depth: number): string {
  const { decls, rules: nested } = contents(nodes);
  const kept = decls.map(d => declaration(d, read)).filter((d): d is string => d !== null).join(';'), inner = sheet(nested, read, depth);
  return kept && inner ? `${kept};${inner}` : kept || inner;
}
// @import "a.css", url(a.css) or url("a.css").
function importAddress(head: Node | undefined): string | null {
  if (head?.kind === 'url' || head?.kind === 'string') return head.value;
  const parts = head?.kind === 'fn' && head.name === 'url' ? head.items.filter(n => n.kind !== 'ws') : [];
  return parts.length === 1 && parts[0]!.kind === 'string' ? parts[0]!.value : null;
}
// A prelude (selectors, media and supports conditions) may load nothing.
const quiet = (nodes: Node[]) => resources(nodes, { resolve: () => null, destinations: [], removed: [] })?.length === 0;
function sheet(list: Rule[], read: Read, depth: number): string {
  let out = '';
  for (const rule of list) {
    if (rule.kind === 'rule') {
      const prelude = quiet(rule.prelude) ? written(rule.prelude) : null;
      if (prelude === null) { read.removed.push('a CSS rule with an unreadable selector'); continue; }
      const body = block(rule.block, read, depth + 1);
      if (body) out += `${prelude.trim()}{${body}}`;
      continue;
    }
    const name = rule.name, prelude = rule.prelude;
    if (name === 'import' && !rule.block && depth === 0) {
      const at = prelude.findIndex(n => n.kind !== 'ws'), head = prelude[at], rest = prelude.slice(at + 1), address = importAddress(head);
      const target = address === null ? null : read.resolve(address.trim()), conditions = quiet(rest) ? written(rest) : null;
      if (!target || conditions === null) { read.removed.push('an @import of an address that is not absolute http(s)'); continue; }
      read.destinations.push(target);
      out += `@import url(${quoted(address!.trim())})${conditions.trim() ? ` ${conditions.trim()}` : ''};`;
    } else if (name === 'font-face' && rule.block) {
      const body = block(rule.block, read, depth + 1);
      if (body) out += `@font-face{${body}}`;
    } else if ((GROUPS.has(name) || KEYFRAMES.test(name)) && quiet(prelude)) {
      const conditions = written(prelude);
      if (conditions === null) { read.removed.push(`an @${name} rule that could not be read back`); continue; }
      const head = `@${ident(name)}${conditions.trim() ? ` ${conditions.trim()}` : ''}`;
      if (!rule.block) { if (name === 'layer') out += `${head};`; continue; }
      const inner = sheet(rules(rule.block, false), read, depth + 1);
      if (inner) out += `${head}{${inner}}`;
    } else read.removed.push(`CSS @${name}`);
  }
  return out;
}
function parse(css: string, resolve: Resolve, as: 'sheet' | 'declarations'): HostedCss {
  const read: Read = { resolve, destinations: [], removed: [] };
  try {
    const nodes = components(tokenize(css));
    const text = as === 'sheet' ? sheet(rules(nodes, true), read, 0) : contents(nodes).decls.map(d => declaration(d, read)).filter(Boolean).join(';');
    // Written back from tokens, the text never ends a <style> element or opens a comment; checked all the same.
    if (/<\/style|<!--/i.test(text)) return { css: '', destinations: [], removed: ['a style sheet that could not be read back'] };
    return { css: text, destinations: [...new Set(read.destinations)], removed: read.removed };
  } catch (error) {
    if (error instanceof Limit) return { css: '', destinations: [], removed: ['a style sheet over the CSS budget'] };
    throw error;
  }
}
/** A <style> sheet as delivered. */
export const hostedSheet = (css: string, resolve: Resolve) => parse(css, resolve, 'sheet');
/** A style attribute as delivered. Rules nested in it mean nothing there and are left out. */
export const hostedDeclarations = (css: string, resolve: Resolve) => parse(css, resolve, 'declarations');
/** Whether a CSS value (an SVG presentation attribute) loads anything but a reference within the message. */
export function loadsResource(value: string): boolean {
  try { return resources(components(tokenize(value)), { resolve: () => null, destinations: [], removed: [] }) === null; }
  catch (error) { if (error instanceof Limit) return true; throw error; }
}
