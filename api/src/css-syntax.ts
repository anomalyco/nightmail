/** CSS Syntax Level 3, bounded: a tokenizer, component values, rules and declarations, and a serializer that writes
 *  tokens back so they read as the same tokens. Shared by the mail-client preview (src/email-preview/css.ts) and the
 *  Hosted copy's style sheets (src/hosted-css.ts). Comments are dropped by the tokenizer, as by every CSS parser. */

export const MAX_TOKENS = 150_000, MAX_DEPTH = 24;
/** A budget was exceeded: callers drop what they were reading. */
export class Limit extends Error {}

// ----- Tokens ------------------------------------------------------------------------------------------------------

export type Kind = 'ident' | 'function' | 'at' | 'hash' | 'string' | 'url' | 'delim' | 'number' | 'percentage' | 'dimension'
  | 'ws' | ':' | ';' | ',' | '[' | ']' | '(' | ')' | '{' | '}' | 'cdo' | 'cdc' | 'bad';
export type Token = { kind: Kind; value: string; unit: string; num: number; escaped: boolean; id: boolean; at: number };
export type Block = { kind: 'block'; open: '{' | '[' | '('; items: Node[] };
export type Func = { kind: 'fn'; name: string; items: Node[] };
export type Node = Token | Block | Func;

export const isWs = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n';
export const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
export const isNameStart = (c: string | undefined) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c.charCodeAt(0) >= 0x80);
export const isName = (c: string | undefined) => isNameStart(c) || isDigit(c) || c === '-';

export function tokenize(input: string, comments?: { found: boolean }): Token[] {
  const s = input.replace(/\r\n?|\f/g, '\n').replace(/\0/g, '\uFFFD');
  const out: Token[] = [];
  let i = 0;
  const push = (kind: Kind, at: number, value = '', extra?: Partial<Token>) => {
    if (out.length >= MAX_TOKENS) throw new Limit();
    out.push({ kind, value, unit: '', num: 0, escaped: false, id: false, at, ...extra });
  };
  const validEscape = (j: number) => s[j] === '\\' && s[j + 1] !== undefined && s[j + 1] !== '\n';
  const startsIdent = (j: number) => s[j] === '-' ? isNameStart(s[j + 1]) || s[j + 1] === '-' || validEscape(j + 1) : isNameStart(s[j]) || validEscape(j);
  const startsNumber = (j: number) => {
    const c = s[j];
    if (c === '+' || c === '-') return isDigit(s[j + 1]) || (s[j + 1] === '.' && isDigit(s[j + 2]));
    return c === '.' ? isDigit(s[j + 1]) : isDigit(c);
  };
  const escape = () => {
    i++;
    const hex = /^[0-9a-fA-F]{1,6}/.exec(s.slice(i, i + 6));
    if (hex) {
      i += hex[0].length;
      if (isWs(s[i])) i++;
      const cp = parseInt(hex[0], 16);
      return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(cp);
    }
    if (i >= s.length) return '\uFFFD';
    const cp = s.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    return String.fromCodePoint(cp);
  };
  const name = () => {
    let v = '', esc = false;
    for (;;) {
      if (isName(s[i])) v += s[i++];
      else if (validEscape(i)) { v += escape(); esc = true; }
      else return { v, esc };
    }
  };
  const remnants = () => { while (i < s.length) { if (s[i] === ')') { i++; return; } if (validEscape(i)) escape(); else i++; } };
  while (i < s.length) {
    const c = s[i]!, start = i;
    if (c === '/' && s[i + 1] === '*') { const end = s.indexOf('*/', i + 2); i = end < 0 ? s.length : end + 2; if (comments) comments.found = true; continue; }
    if (isWs(c)) { while (isWs(s[i])) i++; push('ws', start); continue; }
    if (c === '"' || c === "'") {
      i++;
      let v = '', bad = false, esc = false;
      while (i < s.length) {
        const d = s[i]!;
        if (d === c) { i++; break; }
        if (d === '\n') { bad = true; break; }
        if (d === '\\') {
          if (s[i + 1] === undefined) { i++; continue; }
          if (s[i + 1] === '\n') { i += 2; continue; }
          v += escape(); esc = true; continue;
        }
        v += d; i++;
      }
      push(bad ? 'bad' : 'string', start, v, { escaped: esc });
      continue;
    }
    if (c === '#') {
      if (isName(s[i + 1]) || validEscape(i + 1)) { i++; const id = startsIdent(i), n = name(); push('hash', start, n.v, { escaped: n.esc, id }); }
      else { i++; push('delim', start, '#'); }
      continue;
    }
    if ('(),:;[]{}'.includes(c)) { i++; push(c as Kind, start); continue; }
    if (startsNumber(i)) {
      const m = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i, i + 64))!;
      i += m[0].length;
      const num = Number(m[0]);
      if (startsIdent(i)) { const n = name(); push('dimension', start, m[0], { num, unit: n.v.toLowerCase(), escaped: n.esc }); }
      else if (s[i] === '%') { i++; push('percentage', start, m[0], { num }); }
      else push('number', start, m[0], { num });
      continue;
    }
    if (c === '-' && s.startsWith('-->', i)) { i += 3; push('cdc', start); continue; }
    if (startsIdent(i)) {
      const n = name();
      if (s[i] !== '(') { push('ident', start, n.v, { escaped: n.esc }); continue; }
      i++;
      if (n.v.toLowerCase() !== 'url') { push('function', start, n.v.toLowerCase(), { escaped: n.esc }); continue; }
      let j = i;
      while (isWs(s[j])) j++;
      if (s[j] === '"' || s[j] === "'") { push('function', start, 'url', { escaped: n.esc }); continue; }
      i = j;
      let v = '', bad = false;
      for (;;) {
        const d = s[i];
        if (d === undefined) break;
        if (d === ')') { i++; break; }
        if (isWs(d)) { while (isWs(s[i])) i++; if (s[i] === ')') { i++; break; } if (s[i] === undefined) break; bad = true; remnants(); break; }
        if (d === '"' || d === "'" || d === '(' || (d.charCodeAt(0) < 0x20 && d !== '\t') || d === '\x7f') { bad = true; remnants(); break; }
        if (d === '\\') { if (validEscape(i)) { v += escape(); continue; } bad = true; remnants(); break; }
        v += d; i++;
      }
      push(bad ? 'bad' : 'url', start, v);
      continue;
    }
    if (c === '<' && s.startsWith('<!--', i)) { i += 4; push('cdo', start); continue; }
    if (c === '@' && startsIdent(i + 1)) { i++; const n = name(); push('at', start, n.v, { escaped: n.esc }); continue; }
    const cp = s.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    push('delim', start, String.fromCodePoint(cp));
  }
  return out;
}

/** Component values: blocks and functions nested, depth-bounded. Unclosed blocks end at the end of input. */
export function components(tokens: Token[]): Node[] {
  let i = 0;
  const close = { '{': '}', '[': ']', '(': ')' } as const;
  const list = (end: string | null, depth: number): Node[] => {
    if (depth > MAX_DEPTH) throw new Limit();
    const items: Node[] = [];
    while (i < tokens.length) {
      const t = tokens[i++]!;
      if (end && t.kind === end) return items;
      if (t.kind === '{' || t.kind === '[' || t.kind === '(') items.push({ kind: 'block', open: t.kind, items: list(close[t.kind], depth + 1) });
      else if (t.kind === 'function') items.push({ kind: 'fn', name: t.value, items: list(')', depth + 1) });
      else items.push(t);
    }
    return items;
  };
  return list(null, 0);
}

// ----- Rules and declarations ----------------------------------------------------------------------------------------

export type Rule = { kind: 'rule'; prelude: Node[]; block: Node[] } | { kind: 'atrule'; name: string; prelude: Node[]; block: Node[] | null };
export type Decl = { name: string; value: Node[]; important: boolean; bang: string; spaced: boolean; escaped: boolean };
export type Contents = { decls: Decl[]; rules: Rule[]; malformed: boolean };

export function atRule(nodes: Node[], i: number, name: string): [Rule, number] {
  const prelude: Node[] = [];
  let block: Node[] | null = null;
  for (i++; i < nodes.length; i++) {
    const m = nodes[i]!;
    if (m.kind === ';') { i++; break; }
    if (m.kind === 'block' && m.open === '{') { block = m.items; i++; break; }
    prelude.push(m);
  }
  return [{ kind: 'atrule', name: name.toLowerCase(), prelude, block }, i];
}

/** A list of rules. A qualified rule without a block (end of input) is dropped. */
export function rules(nodes: Node[], top: boolean): Rule[] {
  const out: Rule[] = [];
  let prelude: Node[] = [];
  for (let i = 0; i < nodes.length;) {
    const n = nodes[i]!;
    if (!prelude.length && (n.kind === 'ws' || (top && (n.kind === 'cdo' || n.kind === 'cdc')))) { i++; continue; }
    if (!prelude.length && n.kind === 'at') { const [rule, next] = atRule(nodes, i, n.value); out.push(rule); i = next; continue; }
    if (n.kind === 'block' && n.open === '{') { out.push({ kind: 'rule', prelude, block: n.items }); prelude = []; }
    else prelude.push(n);
    i++;
  }
  return out;
}

export function declaration(part: Node[]): Decl | null {
  let i = 0;
  while (part[i]?.kind === 'ws') i++;
  const head = part[i];
  if (head?.kind !== 'ident') return null;
  for (i++; part[i]?.kind === 'ws'; i++);
  if (part[i]?.kind !== ':') return null;
  const value = part.slice(i + 1);
  let end = value.length, start = 0, important = false, bang = '', spaced = true;
  while (end && value[end - 1]!.kind === 'ws') end--;
  const last = value[end - 1];
  if (last?.kind === 'ident' && last.value.toLowerCase() === 'important') {
    let j = end - 2;
    while (j >= 0 && value[j]!.kind === 'ws') j--;
    const b = value[j];
    if (b?.kind === 'delim' && b.value === '!') {
      important = true; bang = last.value; spaced = j > 0 && value[j - 1]!.kind === 'ws'; end = j;
      while (end && value[end - 1]!.kind === 'ws') end--;
    }
  }
  while (start < end && value[start]!.kind === 'ws') start++;
  const name = head.value.startsWith('--') ? head.value : head.value.toLowerCase();
  return { name, value: value.slice(start, end), important, bang, spaced, escaped: head.escaped };
}

/** A style block: declarations, plus nested rules (CSS Nesting) and at-rules. */
export function contents(nodes: Node[]): Contents {
  const decls: Decl[] = [], nested: Rule[] = [];
  let malformed = false;
  for (let i = 0; i < nodes.length;) {
    const n = nodes[i]!;
    if (n.kind === 'ws' || n.kind === ';') { i++; continue; }
    if (n.kind === 'at') { const [rule, next] = atRule(nodes, i, n.value); nested.push(rule); i = next; continue; }
    const custom = n.kind === 'ident' && n.value.startsWith('--'), part: Node[] = [];
    let block: Block | null = null;
    for (; i < nodes.length; i++) {
      const m = nodes[i]!;
      if (m.kind === ';') { i++; break; }
      if (!custom && m.kind === 'block' && m.open === '{') { block = m; i++; break; }
      part.push(m);
    }
    if (block) { nested.push({ kind: 'rule', prelude: part, block: block.items }); continue; }
    const d = declaration(part);
    if (d) decls.push(d); else malformed = true;
  }
  return { decls, rules: nested, malformed };
}

export const splitComma = (nodes: Node[]) => {
  const parts: Node[][] = [[]];
  for (const n of nodes) if (n.kind === ',') parts.push([]); else parts[parts.length - 1]!.push(n);
  return parts;
};
export const solid = (nodes: Node[]) => nodes.filter(n => n.kind !== 'ws');
export const lower = (n: Node | undefined) => n?.kind === 'ident' ? n.value.toLowerCase() : '';

// ----- Serialization -------------------------------------------------------------------------------------------------

export const hexEscape = (c: number) => `\\${c.toString(16)} `;
/** CSSOM "serialize an identifier", escaping every non-name ASCII character as hex so no `<` or `\` survives. */
export function ident(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) out += '\uFFFD';
    else if (c <= 0x1f || c === 0x7f || (i === 0 && c >= 48 && c <= 57) || (i === 1 && c >= 48 && c <= 57 && s.charCodeAt(0) === 45) || (c === 45 && i === 0 && s.length === 1)) out += hexEscape(c);
    else if (c >= 0x80 || c === 45 || c === 95 || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) out += s[i];
    else out += hexEscape(c);
  }
  return out;
}
export const nameText = (s: string) => [...s].map(ch => isName(ch) ? ch : hexEscape(ch.codePointAt(0)!)).join('');
export function string(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c === 0 ? '\uFFFD' : c <= 0x1f || c === 0x7f || ch === '"' || ch === '\\' || ch === '<' || ch === '>' || ch === '&' || ch === "'" ? hexEscape(c) : ch;
  }
  return out + '"';
}
export const unitText = (u: string) => /^e/i.test(u) ? hexEscape(u.charCodeAt(0)) + nameText(u.slice(1)) : ident(u);
export const number = (n: Token) => n.value + (n.kind === 'percentage' ? '%' : n.kind === 'dimension' ? unitText(n.unit) : '');

export type Piece = 'word' | 'fn' | 'paren' | 'minus' | 'slash' | 'star' | 'other';
/** Joins serialized tokens, adding a space wherever two neighbours would otherwise re-tokenize as one (or as a comment). */
export class Out {
  text = '';
  private last: Piece | 'none' = 'none';
  private space = false;
  ws() { if (this.last !== 'none') this.space = true; }
  push(t: string, kind: Piece) {
    const a = this.last, b = kind;
    if (this.space || (a === 'word' && (b === 'word' || b === 'fn' || b === 'paren' || b === 'minus')) || (a === 'minus' && (b === 'word' || b === 'fn' || b === 'minus'))
      || (a === 'slash' && b === 'star') || (a === 'star' && b === 'slash')) this.text += ' ';
    this.space = false;
    this.text += t;
    this.last = kind;
  }
}

/** Preludes (media, supports, nth arguments): plain tokens and parentheses only. */
export function rawText(nodes: Node[], delims: string): string | null {
  const out = new Out();
  for (const n of nodes) {
    switch (n.kind) {
      case 'ws': out.ws(); break;
      case 'ident': out.push(ident(n.value), 'word'); break;
      case 'number': case 'percentage': case 'dimension': out.push(number(n), 'word'); break;
      case 'string': out.push(string(n.value), 'other'); break;
      case ':': case ',': out.push(n.kind, 'other'); break;
      case 'delim':
        if (!delims.includes(n.value)) return null;
        out.push(n.value, n.value === '-' || n.value === '+' ? 'minus' : n.value === '/' ? 'slash' : 'other');
        break;
      case 'block': {
        if (n.open !== '(') return null;
        const t = rawText(n.items, delims);
        if (t === null) return null;
        out.push(`(${t})`, 'paren');
        break;
      }
      default: return null;
    }
  }
  return out.text;
}

