import { ApiError } from './core/errors.js';
import { digest } from './core/http.js';
import type { Config, Runtime, ScreenClassifier, ScreenModel } from './core/types.js';
import type { EmailSnapshot } from './db/sending.js';
import { errorTypeOf, log } from './log.js';
import { keepScreenCall, outbound } from './screen-calls.js';
import { CircuitBreaker, keepShadow, type ShadowItem } from './screen-shadow.js';
import { cssRules, selectorList, selectorSubjects, stringEnd, unescapeCss, VISIBLE_WORDS } from './screened-html.js';
import { formattedSender } from './sending/mime.js';
import { SEND_LIMITS } from './send-limits.js';

// The outbound gate asks whether the mail would deceive or harm its recipient. Each model has its own cutoff.

const MAX_BODY = 8000;
// Link signals (every host a message links or loads, and link labels that name another host) repeat in each request.
const MAX_SIGNALS = SEND_LIMITS.screen.linkHosts, MAX_SIGNAL_BYTES = SEND_LIMITS.screen.linkHostBytes, OVERLAP = 256;
/** Requests the longest text a limit admits needs: windows of a request less the most signals, overlapping by 256 bytes
 *  and a few bytes less at UTF-8 boundaries. With the most signals (3,000 bytes) a window holds 4,999 bytes of text and
 *  each later one 4,737 new, so 64 KiB (the message limit) takes at most 14 and 128 KiB (a campaign copy's) 28. A message
 *  with few hosts gets wider windows (its own signals, not the most, are subtracted) and needs fewer: about 9 and 18. */
export const chunksFor = (limitBytes: number) => { const width = MAX_BODY - MAX_SIGNAL_BYTES - 1; return 1 + Math.ceil(Math.max(0, limitBytes - width) / (width - OVERLAP - 6)); };
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const DEADLINE_MS = 500;
const PRIMARY_FAILURES = 3, PRIMARY_COOLDOWN_MS = 60_000;
const WINDOW_CONCURRENCY = 4;
const primaryBreakers = new Map<string, CircuitBreaker>();
const failoverEligible = (timing: CallTiming) =>
  timing.outcome === 'timeout' || timing.outcome === 'network' || timing.outcome === 'invalid' ||
  (timing.httpStatus !== undefined && (timing.httpStatus === 401 || timing.httpStatus === 402 || timing.httpStatus === 403 || timing.httpStatus === 429 || timing.httpStatus === 451 || timing.httpStatus >= 500));
// 451 is visitor-country-specific at the primary edge: fail over for that request without tripping the global breaker.
const tripsPrimaryBreaker = (timing: CallTiming) => failoverEligible(timing) && timing.httpStatus !== 451;
// Bound concurrent failover requests per runtime so they don't exhaust the Worker's 6 outbound connections.
const failoverSlots = new WeakMap<object, { active: number; waiting: (() => void)[] }>();
const QUESTIONS = {
  harm: {
    type: 'noul',
    instructions: "You screen outgoing email for a sending platform. Flag only mail that would deceive or harm the person receiving it. Cold sales emails and promotions are allowed. Sign-in links, verification codes and account notices from the service the recipient uses are allowed. A notification that merely quotes someone else's message is allowed.",
    criteria: {
      true: 'The sender pretends to be a company, bank, courier, government body or news outlet that it is not; asks for passwords, card details, fees or payments under false pretences; promises money, prizes, investment returns or miracle cures that are not real; or sells something illegal such as stolen personal data',
      false: 'The sender is honest about who it is and what it wants, including unsolicited sales pitches, marketing, receipts, codes and notifications',
    },
  },
};

// `spam` is the historical field in stored verdicts and rejection events. Its value is the harm score.
export type ScreenResult = { spam: number; model: string; threshold: number; digest?: string };
/** A flagged window wins over a clean one, even if the clean model gave a higher raw score. */
export function decisiveVerdict(a: ScreenResult, b: ScreenResult): ScreenResult {
  const flaggedA = a.spam >= a.threshold, flaggedB = b.spam >= b.threshold;
  if (flaggedA !== flaggedB) return flaggedA ? a : b;
  return a.spam >= b.spam ? a : b;
}
// Verdicts for the old question, a different primary, or different cutoffs cannot be reused.
function policyKey(settings: Config['screen']) {
  const provider = (m?: ScreenModel) => m ? [m.endpoint, m.model, m.threshold] : null;
  return ['harm-v1', settings?.primary, provider(settings?.jevf), provider(settings?.jev)];
}
// Bulk invitations repeat identical content, so one verdict serves every copy for an hour.
// Insertion order is age order: the first key is always the oldest entry.
const cache = new Map<string, { expires: number; result: ScreenResult }>();
const flights=new WeakMap<Runtime['storage'],Map<string,Promise<ScreenResult>>>();

// The text as a reader sees it: compatibility forms folded, and the characters that draw nothing (format controls,
// combining marks, Hangul fillers and other default-ignorable code points) removed.
const normalize = (s: string) => s.normalize('NFKC').replace(/[\p{Cf}\p{Mn}\p{Default_Ignorable_Code_Point}]/gu, '');
function copy(s = '') {
  const sentences = normalize(s).split(/\n+|(?<=[.!?])\s+/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return [...new Set(sentences)].join(' ');
}
const bytes = (n: number) => n.toLocaleString('en-US');
function refused(message: string, details?: Record<string, unknown>, index?: number) {
  const error = new ApiError(422, 'CONTENT_TOO_LARGE_TO_SCREEN', message, index === undefined ? undefined : `emails.${index}`);
  if (details) error.details = [{ ...details, ...(index === undefined ? {} : { index }) }];
  return error;
}
const unreadable = () => refused('Shorten the message so Hosted sending can screen it.');
/** Over the screened-text limit: the measured size and the limit, so the sender knows how much to cut. */
export const tooLarge = (screenedBytes: number, limitBytes: number, scope: 'message' | 'campaign' = 'message', index?: number) =>
  refused(`The screened text is ${bytes(screenedBytes)} UTF-8 bytes; Hosted sending screens at most ${bytes(limitBytes)} per ${scope}. It counts the HTML's text (with its alt and title text), the text part and raw MIME. Shorten the copy by ${bytes(screenedBytes - limitBytes)} bytes.`,
    { screenedBytes, limitBytes }, index);
const tooManyHosts = (linkHosts: number, index?: number) =>
  refused(`The message links to or loads ${linkHosts} distinct hosts (counting link labels that name another host); Hosted sending screens at most ${MAX_SIGNALS}, with ${bytes(MAX_SIGNAL_BYTES)} bytes of host names in all. Link to fewer domains.`,
    { linkHosts, linkHostLimit: MAX_SIGNALS }, index);
// Repeat link signals and a little preceding context in each window. Split on
// UTF-8 boundaries; a clean result is meaningful only after the last window.
function completeBodies(content: string, links: string, limitBytes: number, scope: 'message' | 'campaign' = 'message') {
  const bytes = Buffer.from(content), prefix = links ? links+'\n' : '', most = chunksFor(limitBytes);
  if (bytes.length > limitBytes) throw tooLarge(bytes.length, limitBytes, scope);
  if (Buffer.byteLength(links) > MAX_SIGNAL_BYTES) throw tooManyHosts(links.split('\n').length);
  const bodies: string[] = [], width = MAX_BODY - Buffer.byteLength(prefix);
  let start = 0;
  do {
    if (bodies.length === most) throw tooLarge(bytes.length, limitBytes, scope);
    let end = Math.min(bytes.length, start + width);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    bodies.push(prefix + bytes.toString('utf8', start, end));
    if (end === bytes.length) break;
    start = end - OVERLAP;
    while ((bytes[start]! & 0xc0) === 0x80) start--;
  } while (true);
  return bodies;
}
function host(value: string) {
  try { return new URL(value.startsWith('//') ? 'https:'+value : value).hostname.toLowerCase(); } catch { return ''; }
}
// ----- What style sheets draw ------------------------------------------------------------------------------------------
// A sender off probation keeps its markup (src/sending/claim.ts prepareMail), so its screen reads what CSS can put on screen
// in any media query or color scheme: the strings its declarations draw (generated content, quotes, list markers,
// counter-style symbols, custom properties), with var() and attr() resolved; the hosts its url()s and imports load; and
// elements a client hides by default (style, script, title, xml) that a rule or their own style may display. CSS is read
// as a client tokenizes it: identifiers, function names, property names and attribute names with their escapes decoded
// (\61ttr( is attr(), data-\63opy is data-copy), and the same tokens decide what draws and what it draws. Past a budget
// (distinct variants, var() depth, work) the message is refused as unreadable, never read in part.
// An identifier as CSS tokenizes it, escapes included: custom property names (--x) too.
const IDENT = /(?:--|-?(?:[_a-zA-Z\u0080-\uffff]|\\[0-9a-fA-F]{1,6}(?:\r\n|[ \t\n\r\f])?|\\[^\n\r\f0-9a-fA-F]))(?:[-\w\u0080-\uffff]|\\[0-9a-fA-F]{1,6}(?:\r\n|[ \t\n\r\f])?|\\[^\n\r\f0-9a-fA-F])*/y;
type Piece = { text: string } | { ident: string } | { attr: string; fallback?: Piece[] } | { variable: string; fallback?: Piece[] };
/** The end of a function's arguments that start at i: its closing parenthesis (strings and escapes skipped), or the end. */
function argumentsEnd(value: string, i: number) {
  for (let depth = 1; i < value.length; i++) {
    const c = value[i]!;
    if (c === '\\') i++;
    else if (c === '"' || c === "'") i = stringEnd(value, i) - 1;
    else if (c === '(') depth++;
    else if (c === ')' && !--depth) return i;
  }
  return value.length;
}
/** The first top-level comma of a function's arguments, or -1. */
function topComma(value: string) {
  for (let i = 0, depth = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === '\\') i++;
    else if (c === '"' || c === "'") i = stringEnd(value, i) - 1;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && !depth) return i;
  }
  return -1;
}
/** The identifier at the start of a function's arguments, decoded, or ''. */
function leadingIdent(value: string) {
  const i = value.length - value.trimStart().length;
  IDENT.lastIndex = i;
  const m = IDENT.exec(value);
  return m ? unescapeCss(m[0]) : '';
}
/** A declaration's value as the tokens that can draw text: strings, identifiers, attr() and var() with their fallbacks. */
function pieces(value: string): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < value.length;) {
    const c = value[i]!;
    if (c === '"' || c === "'") { const end = stringEnd(value, i); out.push({ text: unescapeCss(value.slice(i + 1, value[end - 1] === c && end - 1 > i ? end - 1 : end)) }); i = end; continue; }
    IDENT.lastIndex = i;
    const ident = IDENT.exec(value);
    if (!ident) { i++; continue; }
    const name = unescapeCss(ident[0]), after = i + ident[0].length;
    if (value[after] !== '(') { out.push({ ident: name }); i = after; continue; }
    // A function: its name decoded and folded, its arguments read by the same rules.
    const close = argumentsEnd(value, after + 1), argument = value.slice(after + 1, close), comma = topComma(argument), fn = name.toLowerCase();
    const fallback = comma < 0 ? undefined : pieces(argument.slice(comma + 1));
    if (fn === 'attr') out.push({ attr: leadingIdent(argument).toLowerCase(), ...(fallback ? { fallback } : {}) });
    else if (fn === 'var') out.push({ variable: leadingIdent(argument), ...(fallback ? { fallback } : {}) });
    else if (fn !== 'url') out.push(...pieces(argument));
    i = close + 1;
  }
  return out;
}
// Properties whose strings name fonts, files or grid areas: never drawn as text.
const UNDRAWN = new Set(['font', 'font-family', 'src', 'font-feature-settings', 'font-variation-settings', 'font-language-override', 'font-palette', 'grid-template-areas', 'grid-template', 'grid', 'will-change']);
// Counter styles draw their symbols, identifiers included.
const SYMBOLS = new Set(['symbols', 'additive-symbols', 'prefix', 'suffix', 'pad', 'negative']);
const CSS_STEPS = 1_000_000, VARIANTS = 64, VAR_DEPTH = 16;
/** The style sheets and style attributes of a message, read for what they can draw and load (see above). */
function cssReader(sheets: string[], styles: string[], hosts: Set<string>) {
  const rules = sheets.flatMap(sheet => cssRules(sheet)), inline = styles.flatMap(style => cssRules(style)[0]!.decls);
  // Hosts as written and with escapes decoded: an escaped url() or import loads the same host.
  for (const sheet of [...sheets, ...styles]) {
    const css = sheet.replace(/\/\*[\s\S]*?\*\//g, ' ');
    for (const text of [css, unescapeCss(css)]) for (const m of normalize(text).matchAll(/(?:https?:)?\/\/[^\s,)'"<>]+/gi)) { const h = host(m[0]); if (h) hosts.add(h); }
  }
  let steps = 0;
  const parsed = new Map<string, Piece[]>();
  const tokens = (value: string) => { let p = parsed.get(value); if (!p) { if ((steps += value.length) > CSS_STEPS) throw unreadable(); parsed.set(value, p = pieces(value)); } return p; };
  const decls = [...rules.flatMap(rule => rule.decls), ...inline], properties = new Map<string, string[]>();
  for (const [name, value] of decls) if (name.startsWith('--')) properties.set(name, [...properties.get(name) ?? [], value]);
  // What a run of tokens refers to, var() followed through the custom properties: whether it can draw text, and whether
  // that text reads an element's attributes. A cycle or a chain past the depth budget is unreadable.
  const refers = (list: Piece[], idents: boolean, seen: string[] = []): { draws: boolean; attributes: boolean } => {
    let draws = false, attributes = false;
    for (const piece of list) {
      if (++steps > CSS_STEPS) throw unreadable();
      if ('text' in piece) draws = true;
      else if ('ident' in piece) draws ||= idents;
      else {
        if ('attr' in piece) { draws = true; attributes = true; }
        else for (const value of properties.get(piece.variable) ?? []) {
          if (seen.includes(piece.variable) || seen.length >= VAR_DEPTH) throw unreadable();
          const inner = refers(tokens(value), idents, [...seen, piece.variable]);
          draws ||= inner.draws; attributes ||= inner.attributes;
        }
        if (piece.fallback) { const inner = refers(piece.fallback, idents, seen); draws ||= inner.draws; attributes ||= inner.attributes; }
      }
    }
    return { draws, attributes };
  };
  const evaluate = (list: Piece[], element: Map<string, string> | null, idents: boolean, seen: string[] = []): string[] => {
    let variants = [''];
    const append = (texts: string[]) => {
      variants = [...new Set(variants.flatMap(v => texts.map(t => v + t)))];
      if (variants.length > VARIANTS) throw unreadable();
    };
    for (const piece of list) {
      if (++steps > CSS_STEPS) throw unreadable();
      if ('text' in piece) append([piece.text]);
      else if ('ident' in piece) { if (idents) append([piece.ident + ' ']); }
      else if ('attr' in piece) { const value = element?.get(piece.attr); append(value !== undefined ? [value] : piece.fallback ? evaluate(piece.fallback, element, idents, seen) : ['']); }
      else {
        const values = properties.get(piece.variable);
        if (values?.length && (seen.includes(piece.variable) || seen.length >= VAR_DEPTH)) throw unreadable();
        append(values?.length ? values.flatMap(v => evaluate(tokens(v), element, idents, [...seen, piece.variable])) : piece.fallback ? evaluate(piece.fallback, element, idents, seen) : ['']);
      }
    }
    return variants;
  };
  const drawn: { list: Piece[]; idents: boolean; attributes: boolean }[] = [];
  for (const [name, value] of decls) {
    if (UNDRAWN.has(name)) continue;
    const list = tokens(value), idents = SYMBOLS.has(name), { draws, attributes } = refers(list, idents);
    if (draws) drawn.push({ list, idents, attributes });
  }
  const names = new Set<string>();
  const collect = (list: Piece[]) => { for (const piece of list) if ('attr' in piece || 'variable' in piece) { if ('attr' in piece) names.add(piece.attr); if (piece.fallback) collect(piece.fallback); } };
  for (const value of new Set([...decls.map(([, value]) => value)])) collect(tokens(value));
  const perElement = drawn.filter(d => d.attributes);
  // Every declaration once without attributes (an element without them draws attr()'s fallback), then per element below.
  const texts = new Set(drawn.flatMap(d => evaluate(d.list, null, d.idents)).map(t => t.trim()).filter(Boolean));
  // Rules that may display an element: a display other than none, or all (which resets it), on a selector whose subject
  // (its last compound, without pseudo-elements) the element could meet (selectorSubjects). Past its budget the sheet
  // is unreadable.
  const subjects = selectorSubjects<true>(), step = () => { if (++steps > CSS_STEPS) throw unreadable(); };
  for (const rule of rules) if (rule.prelude && !rule.prelude.startsWith('@') && displays(rule.decls))
    for (const { bare } of selectorList(rule.prelude)) if (!/::|:(?:before|after|first-line|first-letter)\b/i.test(bare) && !subjects.add(bare, true)) throw unreadable();
  return {
    texts,
    /** What attr() draws for this element: every declaration that reads one of its attributes, with them resolved. */
    attributes: (attrs: { name: string; value: string }[]) => {
      if (!perElement.length || !attrs.some(a => names.has(a.name))) return [];
      const element = new Map(attrs.map(a => [a.name, a.value]));
      return perElement.flatMap(d => evaluate(d.list, element, d.idents)).map(t => t.trim()).filter(Boolean);
    },
    /** Whether CSS may display an element a client hides by default. */
    shown: (tag: string, attrs: { name: string; value: string }[]) => {
      const style = attrs.find(a => a.name === 'style')?.value, classes = new Set((attrs.find(a => a.name === 'class')?.value ?? '').toLowerCase().split(/\s+/)), id = attrs.find(a => a.name === 'id')?.value.toLowerCase();
      return (style !== undefined && displays(cssRules(style)[0]!.decls)) || !subjects.matching({ tag, classes, id }, step).next().done;
    },
  };
}
const displays = (decls: [string, string][]) => decls.some(([name, value]) => name === 'all' || (name === 'display' && !/^none\s*(?:!\s*important)?$/i.test(unescapeCss(value))));
// Elements a client does not display unless CSS says so.
const UNDISPLAYED = new Set(['style', 'script', 'title', 'xml']);
const INLINE=new Set(['a','abbr','b','bdi','bdo','big','cite','code','data','del','dfn','em','font','i','ins','kbd','label','mark','q','s','samp','small','span','strike','strong','sub','sup','time','tt','u','var','wbr','img','input','button','select','textarea','output','meter','progress','picture','source','svg','text','tspan','math','mi','mo','mn','ruby','rt','rp','nobr']);
/**
 * An HTML body as the screen reads it: the text a client lays out, every host it links or loads, anchors whose text
 * names another host than their href, and its links and images (for the support lint, src/deliverability.ts).
 */
export async function readHtml(html: string, visit?: (tag: string) => void) {
  const { boundedHtmlFragment } = await import('./bounded-html.js');
  if (html.length>512*1024) throw unreadable();
  const fragment=boundedHtmlFragment(html,'fragment',{clients:true});
  if (!fragment) throw unreadable();
  const hosts=new Set<string>(), mismatches=new Set<string>(), links:string[]=[], images:{ alt: boolean }[]=[];
  // Text as a client lays it out: inline runs stay one word, block elements end the line, and text a client shows
  // beside the flow (alt, title) follows on its own lines, as does a table row whose cells hold short pieces read
  // glued, the way a recipient reads a word laid out across adjacent cells.
  const lines:string[]=[], aside:string[]=[], rows:string[][]=[]; let line='';
  const flush=()=>{ if(line.trim()) lines.push(line); line=''; };
  // The sheets and style attributes a client applies: in the flow and inside conditional comments, not in a template.
  const sheets:string[]=[], styles:string[]=[];
  const collect=(node:typeof fragment.childNodes[number])=>{
    if ('tagName' in node) { if (node.tagName==='style') sheets.push(node.childNodes.map(child=>'value' in child ? child.value : '').join('')); for (const a of node.attrs) if (a.name==='style') styles.push(a.value); }
    if ('childNodes' in node) for (const child of node.childNodes) collect(child);
  };
  for (const child of fragment.childNodes) collect(child);
  const css=cssReader(sheets,styles,hosts);
  const walk=(node:typeof fragment.childNodes[number], anchor:string)=>{
    if ('value' in node) {
      line+=node.value;
      if(anchor) for(const word of normalize(node.value).split(/\s+/)) {
        if(!word.includes('.') || word.length>2048)continue;
        const label=host(word.includes('://')?word:'https://'+word);
        if(label && label!==anchor) mismatches.add(`${label} → ${anchor}`);
      }
      return;
    }
    const children='childNodes' in node ? node.childNodes : [];
    if (!('tagName' in node)) { for (const child of children) walk(child,anchor); return; }
    const tag=node.tagName;
    visit?.(tag);
    // Hidden text is read like any other: what CSS hides in one client, media query or color scheme shows in another.
    // A template's content is never drawn; style sheets, scripts, the title and Office XML only when CSS displays them.
    if (tag==='template' || tag==='head' || (UNDISPLAYED.has(tag) && !css.shown(tag,node.attrs))) return;
    let display='';
    for (const a of node.attrs) {
      if (['href','src','srcset','background','action','style'].includes(a.name)) {
        for(const m of normalize(a.value).matchAll(/(?:https?:)?\/\/[^\s,)'"<>]+/gi)) { const h=host(m[0]); if(h) hosts.add(h); }
        if(tag==='a' && a.name==='href') { anchor=host(normalize(a.value)); links.push(normalize(a.value)); }
      }
      if (a.name==='style') display=/(?:^|;)\s*display\s*:\s*([a-z-]+)/i.exec(a.value)?.[1]?.toLowerCase() ?? '';
      if (['alt','title'].includes(a.name) && a.value.trim()) aside.push(a.value);
      // Text form controls draw: a field's value and placeholder, an option's label.
      if (((['value','placeholder'].includes(a.name) && (tag==='input' || tag==='textarea')) || (a.name==='label' && (tag==='option' || tag==='optgroup'))) && a.value.trim()) aside.push(a.value);
    }
    aside.push(...css.attributes(node.attrs));
    if (tag==='img') images.push({ alt: node.attrs.some(a=>a.name==='alt' && !!a.value.trim()) });
    const inline=display ? display.startsWith('inline') : INLINE.has(tag);
    if (!inline) flush();
    const start=lines.length;
    if (tag==='tr') rows.push([]);
    for (const child of children) walk(child,anchor);
    // A frame's srcdoc (bounded-html.ts), for a client that shows frames.
    if (tag==='iframe' && 'content' in node) for (const child of (node as unknown as { content: typeof fragment }).content.childNodes) walk(child,anchor);
    if (!inline) flush();
    if (tag==='td' || tag==='th') rows[rows.length-1]?.push(lines.slice(start).join(' '));
    if (tag==='tr') { const cells=rows.pop()!; if (cells.length>1 && cells.some(cell=>cell.trim() && cell.trim().length<=4)) aside.push(cells.join('')); }
  };
  for (const child of fragment.childNodes) walk(child,'');
  flush();
  return { text: [...lines,...aside,...css.texts].join('\n'), hosts, mismatches, links, images };
}
export function screenTextSignals(visible: string, text?: string, rawPart?: string) {
  // Preserve order and repetitions in mandatory input; deduplicating sentences
  // could change the meaning or make an over-limit message appear to fit.
  const project=(s='')=>normalize(s).replace(/\s+/g,' ').trim();
  const plain=project(text), raw=project(rawPart), rendered=project(visible);
  const words=(v:string)=>new Set(v.toLowerCase().match(VISIBLE_WORDS));
  function overlap(text:string, html:string) {
    const a=words(text), b=words(html), common=[...a].filter(w=>b.has(w)).length;
    return a.size && b.size ? common/(a.size+b.size-common) : undefined;
  }
  return { content:[rendered,plain,raw].filter(Boolean).join('\n'), textHtmlOverlap:overlap(plain,rendered) };
}
export type ScreenMeasure = { signals: string[]; content: string; textHtmlOverlap?: number; screenedBytes: number };
/** What the screen reads of a message, measured without asking the classifier: the same text and link signals it sends. */
export async function measureScreen(snapshot: Pick<EmailSnapshot, 'html' | 'text' | 'raw'>): Promise<ScreenMeasure> {
  const read=snapshot.html ? await readHtml(snapshot.html) : undefined;
  const signals=read ? [...read.mismatches,...read.hosts] : [];
  const {content,textHtmlOverlap}=screenTextSignals(read?.text ?? '',snapshot.text,snapshot.raw);
  return { signals, content, textHtmlOverlap, screenedBytes: Buffer.byteLength(content) };
}
/** Refuses a message the screen cannot read within a limit, with the measured size; `index` names a batch item. */
export function assertScreenable(measure: ScreenMeasure, limitBytes: number, scope: 'message' | 'campaign' = 'message', index?: number) {
  if (measure.signals.length>MAX_SIGNALS || Buffer.byteLength(measure.signals.join('\n'))>MAX_SIGNAL_BYTES) throw tooManyHosts(measure.signals.length,index);
  if (measure.screenedBytes>limitBytes) throw tooLarge(measure.screenedBytes,limitBytes,scope,index);
}
async function body(snapshot: EmailSnapshot, limitBytes: number, scope: 'message' | 'campaign' = 'message') {
  const measure=await measureScreen(snapshot);
  assertScreenable(measure,limitBytes,scope);
  return { bodies:completeBodies(measure.content,measure.signals.join('\n'),limitBytes,scope), textHtmlOverlap:measure.textHtmlOverlap };
}
// ----- Classifier request records -------------------------------------------------------------------------------------
// One CONTENT_SCREEN_CALL line per classifier request: how long it took to the response headers (headersMs) and to the end
// of the body (ms), how it ended (outcome: ok, timeout, network, http_<status> or invalid; phase says whether a timeout or
// network error came before or after the headers), the request and response sizes, how many requests this isolate had in
// flight when it started, where it came from (ScreenCall) and the classifier's own request ID and timing headers. Never
// the message, its subject or addresses, the request body or the key. Failures and failovers are always logged; a campaign copy's
// successful primary requests 1 in 10 (CAMPAIGN_SAMPLE, the line says sampleRate), since a campaign can make 50 a second. Each
// line kept is also kept as a content_screen_calls row (src/screen-calls.ts), written after the send, never before it.
/** Where a classifier request came from, for its line: IDs and routing only. The screen writes back how the last request
 *  ended (outcome) and how long it took (ms), for the email's own record (src/sending/dispatcher.ts DISPATCH_EMAIL). */
export type ScreenCall = { emailId?: string; workspaceId?: string; campaignId?: string; region?: string; shard?: number; kind?: string; required?: boolean; outcome?: string; ms?: number;
  /** With the second classifier on (src/screen-shadow.ts): the first 32 characters of the message's verdict cache key, for
   *  its DISPATCH_EMAIL line (a longer run is redacted there as credential-like), so an email served from the cache links
   *  to the screen_comparisons rows of the requests that judged it, at most an hour earlier. */
  digest?: string };
/** How one request went, filled in by jevQuestions as it goes. Only assignments: recording never throws or waits. */
type CallTiming = { classifier?: ScreenClassifier; model?: string; score?: number; threshold?: number; failoverReason?: string; inFlight?: number; sesInFlight?: number; requestBytes?: number; headersMs?: number; ms?: number; outcome?: string; phase?: 'headers' | 'body'; httpStatus?: number; responseBytes?: number;
  requestId?: string; cfRay?: string; serverTiming?: string; retryAfter?: string; errorType?: string; errorCode?: string; errorMessage?: string };
const CAMPAIGN_SAMPLE = 0.1;
let inFlight = 0;
function failed(timing: CallTiming, started: number, phase: 'headers' | 'body', error: unknown) {
  try {
    const { name, cause, message } = error as { name?: unknown; cause?: { code?: unknown }; message?: unknown };
    timing.ms = Date.now() - started; timing.phase = phase; timing.outcome = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network'; timing.errorType = errorTypeOf(error);
    // The runtime's own words for a failed connection ("Network connection lost.", undici's ECONNRESET), never text
    // that could carry a URL, an address or a header.
    if (typeof cause?.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(cause.code)) timing.errorCode = cause.code;
    if (typeof message === 'string' && /^[A-Za-z0-9 .,;:()=_-]{1,120}$/.test(message)) timing.errorMessage = message;
  } catch { /* A record never changes the request's outcome. */ }
}
function responded(timing: CallTiming, started: number, response: Response) {
  try {
    const header = (name: string, max: number) => response.headers.get(name)?.slice(0, max) ?? undefined;
    timing.headersMs = Date.now() - started; timing.httpStatus = response.status;
    timing.requestId = header('x-typesafe-request-id', 80) ?? header('x-request-id', 80); timing.cfRay = header('cf-ray', 40);
    timing.serverTiming = header('server-timing', 300); timing.retryAfter = header('retry-after', 40);
  } catch { /* As above. */ }
}
function logCall(timing: CallTiming, call: ScreenCall | undefined, window: number, windows: number, sample: number, at: number, db: object | undefined) {
  try {
    const ok = timing.outcome === 'ok', sampleRate = ok && !timing.failoverReason ? sample : 1;
    if (call) { call.outcome = timing.outcome; call.ms = timing.ms; }
    if (sampleRate < 1 && Math.random() >= sampleRate) return;
    log(ok ? 'info' : 'warn', { code: 'CONTENT_SCREEN_CALL', emailId: call?.emailId, workspaceId: call?.workspaceId, campaignId: call?.campaignId, region: call?.region, shard: call?.shard,
      kind: call?.kind, required: call?.required, window, windows, ...timing, ...(sampleRate < 1 ? { sampleRate } : {}) });
    keepScreenCall(db, { at, workspaceId: call?.workspaceId, emailId: call?.emailId, campaignId: call?.campaignId, kind: call?.kind, required: call?.required, region: call?.region,
      shard: call?.shard, outcome: timing.outcome, phase: timing.phase, httpStatus: timing.httpStatus, headersMs: timing.headersMs, ms: timing.ms, requestBytes: timing.requestBytes,
      responseBytes: timing.responseBytes, inFlight: timing.inFlight, sesInFlight: timing.sesInFlight, window, windows, requestId: timing.requestId, sampleRate });
  } catch { /* As above. */ }
}
export async function jevQuestions(endpoint:string,apiKey:string,model:string,state:unknown,questions:unknown,deadline:number,timing:CallTiming={}):Promise<unknown> {
  // The deadline includes reading the response body. One attempt at the configured endpoint.
  const started=Date.now();timing.inFlight=++inFlight;timing.sesInFlight=outbound.ses;
  try {
    let response: Response;
    try {
      const body=JSON.stringify({ model, state, questions });timing.requestBytes=Buffer.byteLength(body);
      response = await fetch(endpoint, {
        // Never follow a redirect: the key and the message body go only to the configured endpoint. Workers
        // reject redirect: 'error', so use 'manual'; a 3xx is not ok and counts as unavailable below.
        method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body, signal: AbortSignal.timeout(deadline),
      });
    } catch (error) {
      failed(timing,started,'headers',error);
      throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'The content classifier could not be reached.', undefined, true);
    }
    responded(timing,started,response);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      timing.ms=Date.now()-started;timing.outcome=`http_${response.status}`;
      throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', `The content classifier failed with HTTP ${response.status}.`, undefined, true);
    }
    const reader=response.body?.getReader(); if(!reader){timing.ms=Date.now()-started;return null;}
    // A timeout while reading the body is not an ApiError: it goes on as it always has, recorded on the way.
    const chunks:Uint8Array[]=[];let bytes=0;
    try{for(;;){const {value,done}=await reader.read();if(done)break;if((bytes+=value.length)>32768){await reader.cancel();timing.responseBytes=bytes;timing.ms=Date.now()-started;return null}chunks.push(value)}}
    catch(error){timing.responseBytes=bytes;failed(timing,started,'body',error);throw error;}
    timing.responseBytes=bytes;timing.ms=Date.now()-started;
    try{return JSON.parse(Buffer.concat(chunks).toString())}catch{return null}
  } finally { inFlight--; }
}
/** One window, one verdict. Each actual request has its own deadline, campaign charge and record. */
async function evaluate(runtime: Runtime, state: unknown, call: ScreenCall | undefined, window: number, windows: number, sample: number, shadow?: ShadowRef, charge?: () => Promise<void>): Promise<ScreenResult> {
  const policy = runtime.config.screen!, first = policy.primary, second = first === 'jevf' ? 'jev' : 'jevf';
  const primary = policy[first]!, backup = policy[second];
  const primaryDeadline = first === 'jevf' ? Math.min(DEADLINE_MS, policy.jevf!.deadlineMs) : DEADLINE_MS;
  const ask = async (settings: ScreenModel, deadline: number, timing: CallTiming) => {
    if (charge) await charge();
    const at = Date.now(), { endpoint, apiKey, model } = settings;
    let parsed: { model?: unknown; answers?: { harm?: { noul?: unknown } }; usage?: { input_tokens?: unknown } } | null | undefined;
    try {
      parsed = await jevQuestions(endpoint,apiKey,model,state,QUESTIONS,deadline,timing) as typeof parsed;
      const score = parsed?.answers?.harm?.noul;
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) { timing.outcome='invalid'; throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'The content classifier returned no valid harm score.', undefined, true); }
      timing.outcome = 'ok'; timing.score = score; timing.threshold = settings.threshold;
      // Only a model identifier may enter verdicts or logs; an upstream can return arbitrary strings.
      timing.model = typeof parsed?.model === 'string' && /^[a-zA-Z0-9._:/-]{1,100}$/.test(parsed.model) ? parsed.model : model;
      return { spam: score, model: timing.model, threshold: settings.threshold };
    } catch (error) {
      // A body read can throw a raw stream error/AbortError. Wrap it as retryable outage for both primary and failover.
      if (!(error instanceof ApiError)) throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'The content classifier could not be reached.', undefined, true);
      throw error;
    } finally {
      logCall(timing,call,window,windows,sample,at,runtime.db);
      if (shadow && first === 'jev' && !timing.failoverReason && !(backup && failoverEligible(timing))) shadowed(shadow,runtime.db,at,state,window,windows,timing,parsed?.usage?.input_tokens);
    }
  };
  const timing: CallTiming = { classifier: first };
  if (!backup) return ask(primary, primaryDeadline, timing);
  const key = first + '\n' + primary.endpoint + '\n' + primary.model;
  let breaker = primaryBreakers.get(key);
  if (!breaker) primaryBreakers.set(key, breaker = new CircuitBreaker());
  const now = Date.now(), claim = breaker.tryAcquire(now, PRIMARY_COOLDOWN_MS);
  if (claim) {
    try {
      const result = await ask(primary, primaryDeadline, timing);
      breaker.recordSuccess(claim);
      return result;
    } catch (error) {
      const eligible = failoverEligible(timing), trips = tripsPrimaryBreaker(timing);
      if (trips) breaker.recordFailure(claim, Date.now(), PRIMARY_FAILURES, PRIMARY_COOLDOWN_MS);
      else if (!eligible && timing.outcome) breaker.recordSuccess(claim);
      else breaker.releaseProbe(claim, now); // No global primary outage: leave the probe available.
      if (!eligible) throw error;
    }
  }
  // Jev as the fallback keeps the concurrency it had as the primary (its callers bound it, 4 each): a JevF outage or open
  // breaker sends every screen here, and two slots would halve screening for as long as it lasts.
  if (second === 'jev') return ask(backup, DEADLINE_MS, { classifier: second, failoverReason: timing.outcome ?? 'primary_breaker' });
  let slots = failoverSlots.get(runtime.db);
  if (!slots) failoverSlots.set(runtime.db, slots = { active: 0, waiting: [] });
  if (slots.active < Math.min(2, policy.jevf!.maxConcurrency)) slots.active++;
  else await new Promise<void>(resolve => slots.waiting.push(resolve));
  try {
    return await ask(backup, policy.jevf!.deadlineMs, { classifier: second, failoverReason: timing.outcome ?? 'primary_breaker' });
  } finally {
    const next = slots.waiting.shift(); if (next) next(); else slots.active--;
  }
}
/** What a request is kept with for the second classifier (src/screen-shadow.ts): only made when it is configured. */
type ShadowRef = Pick<ShadowItem, 'kind' | 'digest' | 'threshold' | 'jevfThreshold' | 'workspaceId' | 'emailId' | 'campaignId'>;
// The request just made, kept to be repeated later with the same state and questions: how it ended and, answered, its
// score, model and input tokens. Only assignments, after the request and its record: it never throws, waits or changes
// what evaluate returns.
function shadowed(ref: ShadowRef, db: object | undefined, at: number, state: unknown, window: number, windows: number, timing: CallTiming, tokens: unknown) {
  try {
    keepShadow(db, { ...ref, id: crypto.randomUUID(), at, window, windows, request: { state, questions: QUESTIONS },
      jev: { outcome: timing.outcome ?? 'unknown', httpStatus: timing.httpStatus, ms: timing.ms, score: timing.score,
        model: timing.model, inputTokens: typeof tokens === 'number' ? tokens : undefined } }, timing.requestBytes);
  } catch { /* A record never changes the request's outcome. */ }
}

// The classifier's input for a snapshot: what screenSnapshot sends it, request by request.
function classifierState(snapshot: EmailSnapshot, required: boolean, textHtmlOverlap: number | undefined) {
  const sender=copy(formattedSender(snapshot.from, snapshot.fromName)), subject=copy(snapshot.subject), recipients=snapshot.to.length+snapshot.cc.length+snapshot.bcc.length;
  return (body: string) => ({email:{from:required?sender:sender.slice(0,100),kind:snapshot.kind,subject:required?subject:subject.slice(0,200),body},signals:{recipients,textHtmlOverlap}});
}
/** Harm verdict for one snapshot, or null when the installation has no classifier configured. A campaign test has
 *  the campaign limit. `call` names the email on each request's line and gets the last request's outcome back. */
export async function screenSnapshot(runtime: Runtime, snapshot: EmailSnapshot, required=false, call?: ScreenCall): Promise<ScreenResult | null> {
  const settings = runtime.config.screen;
  if (!settings) return null;
  const from = formattedSender(snapshot.from, snapshot.fromName);
  const recipients=snapshot.to.length+snapshot.cc.length+snapshot.bcc.length;
  const key = await digest(JSON.stringify([runtime.config.workspaceId,policyKey(settings),required,from,snapshot.kind,snapshot.subject,snapshot.text,snapshot.html,snapshot.raw,recipients]));
  const now = Date.now();
  const shadow: ShadowRef | undefined = runtime.config.shadow && { kind: snapshot.testCampaignId ? 'campaign_test' : 'email', digest: key, threshold: settings.jev.threshold, jevfThreshold: runtime.config.shadow.threshold,
    workspaceId: call?.workspaceId ?? runtime.config.workspaceId, emailId: call?.emailId, campaignId: snapshot.testCampaignId ?? call?.campaignId };
  if (shadow && call) call.digest = key.slice(0, 32);
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.result;
  if (hit) cache.delete(key);
  // Concurrent copies share one request; failures are not cached so the next copy retries.
  let pending=flights.get(runtime.storage);if(!pending){pending=new Map();flights.set(runtime.storage,pending);}
  const existing=pending.get(key);if(existing)return existing;
  const limits=runtime.config.screenLimits, test=!!snapshot.testCampaignId;
  const lookup=body(snapshot,test ? limits.campaignBytes : limits.messageBytes,test ? 'campaign' : 'message').then(async ({bodies,textHtmlOverlap})=>{
    const state=classifierState(snapshot,required,textHtmlOverlap);
    // Screen all windows of a long email in parallel (bounded to WINDOW_CONCURRENCY so Worker sockets stay bounded).
    const results: ScreenResult[] = new Array(bodies.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(bodies.length, WINDOW_CONCURRENCY) }, async () => {
      while (next < bodies.length) {
        const w = next++;
        results[w] = await evaluate(runtime, state(bodies[w]!), call, w, bodies.length, 1, shadow);
      }
    }));
    return { ...results.reduce(decisiveVerdict), digest: key };
  });pending.set(key,lookup);
  try{const result=await lookup;cache.set(key,{expires:now+TTL_MS,result});
    while(cache.size>MAX_ENTRIES)cache.delete(cache.keys().next().value!);return result;
  }finally{pending.delete(key);}
}

// A Hosted campaign is screened copy by copy, exactly as single messages are, but each distinct copy only once
// (src/campaigns/materialize.ts campaignVerdicts): a copy's verdict is keyed by the copy as it is delivered (copyKey), so recipients
// whose copies are the same share it.

/** A campaign's screening state, on its review (sending_campaign_reviews.screen). */
export type CampaignScreen = {
  /** The review content it belongs to (sending_campaign_reviews.content_hash). */
  contentHash: string; probation: boolean;
  /** The campaign's own copy, placeholders unresolved. Preparing reviews without a cutoff predate harm and are screened again. */
  template: { key: string; spam: number; model: string; threshold?: number } | null;
  /** Recipients whose copies have verdicts, in send order, and how many of them were refused as spam. */
  screenedThrough: number; recipients: number; rejected: number;
  /** Classifier outages in a row, for the wait before the next attempt; whether the refused share paused it once. */
  failures: number; quarantined: boolean;
};
/**
 * A campaign copy's verdict key: the classifier and model, and the copy exactly as it is delivered (sender, reply-to,
 * subject, HTML, text and raw parts, its headers and attachments), built with the slots Nightmail adds per recipient
 * (the unsubscribe footer's link and the List-Unsubscribe headers) generated for the placeholder link
 * (src/campaigns/materialize.ts screenedAs) rather than the recipient's. The recipient's address isn't part of it.
 */
export async function copyKey(runtime: Runtime, snapshot: EmailSnapshot): Promise<string> {
  const settings = runtime.config.screen;
  return digest(JSON.stringify([policyKey(settings), snapshot.kind, snapshot.from, snapshot.fromName ?? null, snapshot.replyTo,
    snapshot.subject, snapshot.html ?? null, snapshot.text ?? null, snapshot.raw ?? null, snapshot.headers, snapshot.attachments, snapshot.tracking]));
}
/** What the classifier is sent for one campaign copy, request by request: what screenSnapshot sends for that copy as
 *  required Hosted mail to its one recipient, with the campaign limit. */
export type ScreenInput = { requests: unknown[] };
/** A campaign copy's screen input, refused past the campaign limit. */
export async function screenInput(runtime: Runtime, snapshot: EmailSnapshot): Promise<ScreenInput> {
  const { bodies, textHtmlOverlap } = await body(snapshot, runtime.config.screenLimits.campaignBytes, 'campaign');
  const state = classifierState({ ...snapshot, to: ['recipient'], cc: [], bcc: [] }, true, textHtmlOverlap);
  return { requests: bodies.map(state) };
}
/** One request of a campaign copy's screen; `call` names the campaign on its line, `key` the copy (copyKey) for the second classifier's record. */
export async function screenWindow(runtime: Runtime, input: ScreenInput, window: number, call?: ScreenCall, key?: string, charge?: () => Promise<void>): Promise<ScreenResult> {
  const settings = runtime.config.screen;
  if (!settings) throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'Hosted content screening is unavailable.', undefined, true);
  const shadow: ShadowRef | undefined = runtime.config.shadow && key ? { kind: 'campaign_copy', digest: key, threshold: settings.jev.threshold, jevfThreshold: runtime.config.shadow.threshold, workspaceId: call?.workspaceId, campaignId: call?.campaignId } : undefined;
  return evaluate(runtime, input.requests[window], call, window, input.requests.length, CAMPAIGN_SAMPLE, shadow, charge);
}
