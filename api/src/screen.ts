import { ApiError, digest, type Runtime } from './core.js';
import type { EmailSnapshot } from './db/sending.js';
import { VISIBLE_WORDS } from './screened-html.js';
import { fontFaceCss } from './block-style.js';
import { formattedSender } from './sending.js';

// Opt-in content screen for live transactional mail (`screen: true`): asks Jev, TypeSafe AI's decision
// model (directly or through OpenCode's inference gateway, per JEV_ENDPOINT), how likely a message is advertising smuggled into a transactional template (for example a
// gambling ad set as a workspace name in an invitation). The dispatcher decides what to do with the score.

const MAX_BODY = 8000;
// Link signals (every host a message links or loads, and link labels that name another host) repeat in each request.
const MAX_SIGNALS = 60, MAX_SIGNAL_BYTES = 1000, OVERLAP = 256;
/** Requests the longest text a limit admits needs: windows of a request less the most signals, overlapping by 256 bytes
 *  and a few bytes less at UTF-8 boundaries. 24 KiB takes 4; 48 KiB takes 8. */
export const chunksFor = (limitBytes: number) => { const width = MAX_BODY - MAX_SIGNAL_BYTES - 1; return 1 + Math.ceil(Math.max(0, limitBytes - width) / (width - OVERLAP - 6)); };
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const DEADLINE_MS = 500;
const QUESTIONS = {
  spam: {
    type: 'noul',
    instructions: 'For transactional mail, detect unsolicited advertising smuggled into a receipt, invitation or notification. For marketing, do not flag ordinary subscribed promotions: flag deceptive impersonation, credential theft, scams or unrelated malicious pitches.',
    criteria: {
      true: 'The message exists to advertise or lure the recipient to a third-party site, contact or offer unrelated to the sending service',
      false: 'A genuine transactional message: invitation, receipt, code, notification or similar, even if a name in it is unusual',
    },
  },
};

export type ScreenResult = { spam: number; model: string };
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
const unreadable = () => refused('Simplify the HTML so Hosted sending can screen it: it is too large or too deeply nested to read.');
/** Over the screened-text limit: the measured size and the limit, so the sender knows how much to cut. */
export const tooLarge = (screenedBytes: number, limitBytes: number, scope: 'message' | 'campaign' = 'message', index?: number) =>
  refused(`The screened text is ${bytes(screenedBytes)} UTF-8 bytes; Hosted sending screens at most ${bytes(limitBytes)} per ${scope}. It counts the HTML's visible text and alt text, the text part unless it says exactly the same, and each distinct link and image address. Shorten the copy by ${bytes(screenedBytes - limitBytes)} bytes.`,
    { screenedBytes, limitBytes }, index);
/** Markup whose destinations the screen can't read: refused for Hosted mail, named so the sender can fix it. */
export const unsupportedUrls = (unsupported: string[], index?: number) => {
  const error = new ApiError(422, 'UNSUPPORTED_URL_IN_HOSTED_MAIL', `Hosted sending screens every address a message links to or loads from, and can't read where this markup leads: ${unsupported.join('; ')}. Use absolute https:// (or mailto:, tel:, cid:) addresses, and no <base>, <link>, srcset, or CSS url() but background-image: url("https://…") in a style attribute.`, index === undefined ? 'html' : `emails.${index}.html`);
  error.details = [{ unsupported, ...(index === undefined ? {} : { index }) }];
  return error;
};
const tooManyHosts = (linkHosts: number, index?: number) =>
  refused(`The message links to or loads ${linkHosts} distinct hosts (counting link labels that name another host); Hosted sending screens at most ${MAX_SIGNALS}. Link to fewer domains.`,
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
/**
 * Where a URL leads, as a recipient's client resolves it: WHATWG URL parsing with IDNA (so a host with a combining
 * mark is its punycode, not the host it looks like), the canonical scheme, host, port, path, query and fragment, and
 * nothing removed beyond what URL parsing itself removes. Never prose-normalized. Null unless the value is an absolute
 * http(s), mailto or tel URL whose meaning doesn't depend on the document's address: an http(s) URL needs its two
 * slashes, since `https:host` and `https:/host` are relative to an https document.
 */
export function destination(value: string): string | null {
  const v = value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '');
  if (!/^(?:https?:[\\/]{2}|mailto:|tel:)/i.test(v)) return null;
  try { return new URL(v).href; } catch { return null; }
}
const destinationHost = (target: string) => { try { return /^https?:$/.test(new URL(target).protocol) ? new URL(target).hostname : ''; } catch { return ''; } };
// The URL-bearing attribute vocabulary (HTML, SVG, MathML and Office markup), each either in the destination
// inventory as an absolute URL or refused; docs/sending-limits.md has the table. Office prefixes any name (o:href).
const INVENTORY = new Set(['href', 'src', 'background', 'poster', 'action', 'formaction', 'cite', 'longdesc', 'usemap', 'data', 'codebase', 'classid', 'code', 'profile', 'manifest', 'icon', 'lowsrc', 'dynsrc', 'xlink:href']);
// Lists of URLs separated by ASCII whitespace, as the HTML standard splits them.
const URL_LISTS = new Set(['ping', 'attributionsrc']);
// Lists a client splits its own way (srcset candidates, comma-separated applet archives), and other bases.
const REFUSED = new Set(['srcset', 'imagesrcset', 'archive', 'xml:base']);
const isUrlAttribute = (name: string) => INVENTORY.has(name) || URL_LISTS.has(name) || REFUSED.has(name) || /:(?:href|src)$/.test(name);
// Attributes whose value is CSS: style, and SVG presentation attributes that take a url().
const CSS_ATTRIBUTES = new Set(['style', 'fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'cursor', 'color-profile']);
// Elements whose resources depend on a plugin, and SVG animation that can rewrite another attribute.
const PLUGINS = new Set(['applet', 'embed', 'object']), ANIMATIONS = new Set(['animate', 'animatecolor', 'set']);
const SVG = 'http://www.w3.org/2000/svg';
/**
 * Whether CSS can load anything: its escapes decoded as CSS decodes them, any url(), image(), image-set(), src() or
 * @import refuses it. Comments are left in place: one can only split a token, never make one, so reading through it
 * finds a superset. A url() of a fragment (#id) stays in the document and is allowed.
 */
const cssResource = (css: string) => /(?:url|image|image-set|src)\(|@import/i.test(css
  .replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?|\\([^\n\r\f])/gi, (_, hex: string | undefined, char: string | undefined) => hex ? String.fromCodePoint(parseInt(hex, 16) > 0x10ffff || (parseInt(hex, 16) >= 0xd800 && parseInt(hex, 16) <= 0xdfff) ? 0xfffd : parseInt(hex, 16) || 0xfffd) : char!)
  .replace(/url\(\s*(?:"#[^"\\\n]*"|'#[^'\\\n]*'|#[^"'()\\\s]*)\s*\)/gi, ' '));
/**
 * The one CSS resource a style attribute may carry: `background-image: url("https://…")`, a declaration with a
 * double-quoted absolute https URL, in a style attribute without a backslash (so without escapes). That form is the
 * same text to every CSS tokenizer, so its URL is listed exactly; anything else in the attribute that could load is
 * refused as above.
 */
const BACKGROUND = /(^|;)\s*background-image\s*:\s*url\(\s*"(https:\/\/[^"'\\\s()<>]+)"\s*\)\s*(?:!\s*important\s*)?(?=;|$)/gi;
const styleResources = (value: string) => {
  if (value.includes('\\')) return { urls: [], rest: value };
  const urls = [...value.matchAll(BACKGROUND)].map(match => match[2]!);
  return { urls, rest: value.replace(BACKGROUND, '$1 ') };
};
// The campaign renderer's own web-font sheet, read exactly: its two font files are destinations.
const [FONT_HEAD, FONT_MIDDLE, FONT_TAIL] = fontFaceCss('\u0000').split('\u0000') as [string, string, string];
const fontSheet = (css: string) => {
  if (!css.startsWith(FONT_HEAD) || !css.endsWith(FONT_TAIL)) return null;
  const middle = css.slice(FONT_HEAD.length, css.length - FONT_TAIL.length), split = middle.indexOf(FONT_MIDDLE), base = middle.slice(0, split);
  return split > 0 && middle === base + FONT_MIDDLE + base && /^https?:\/\/[^'"\\\s()<>]+\/$/.test(base) ? [`${base}inter-variable.woff2`, `${base}inter-variable-italic.woff2`] : null;
};
// Addresses a client links in text: absolute http(s) URLs and www. hosts, without the punctuation that ends a sentence.
const textTargets = (text = '') => [...text.matchAll(/(?:\bhttps?:\/\/|\bwww\.)[^\s<>"'`]+/giu)].map(match => (/^www\./i.test(match[0]) ? 'https://' : '') + match[0].replace(/[.,;:!?)\]}'"’”]+$/u, ''));
const INLINE=new Set(['a','abbr','b','bdi','bdo','big','cite','code','data','del','dfn','em','font','i','ins','kbd','label','mark','q','s','samp','small','span','strike','strong','sub','sup','time','tt','u','var','wbr','img','input','button','select','textarea','output','meter','progress','picture','source','svg','text','tspan','math','mi','mo','mn','ruby','rt','rp','nobr']);
type HtmlNode = { nodeName: string; tagName?: string; namespaceURI?: string; value?: string; attrs?: { name: string; prefix?: string; value: string }[]; childNodes?: HtmlNode[]; content?: HtmlNode };
const textOf = (node: HtmlNode): string => node.value ?? (node.childNodes ?? []).map(textOf).join('');
/**
 * Every place an HTML body links to or loads from, as one inventory, and the markup Hosted sending refuses because the
 * screen couldn't read where it leads: <base> and xml:base, <link>, a refresh or Link <meta>, srcset and archive,
 * plugin elements, SVG animation of a URL or CSS attribute, CSS resources in style sheets, style attributes and SVG
 * presentation attributes (but the renderer's own font sheet and `background-image: url("https://…")` in a style
 * attribute), and any URL attribute whose value is not an absolute http(s), mailto or tel URL (relative and
 * network-path references included). A fragment-only reference (#top) or an empty one stays in its document and an
 * attachment reference (cid:) is the message's own, so neither is a destination.
 *
 * The trees are read the way a validator reads them (bounded-html's `clients` trees, `content` included: comments,
 * frame fallbacks and templates a lenient client may show), the body both as a fragment and as a document, whose
 * <html> and <body> keep their attributes. With `placeholders`, a campaign's own copy may start a URL attribute with a
 * placeholder; each recipient's copy is read without it.
 */
function inventory(roots: HtmlNode[], placeholders = false) {
  const destinations = new Set<string>(), unsupported: string[] = [];
  const refuse = (what: string) => { if (!unsupported.includes(what) && unsupported.length < 20) unsupported.push(what); };
  const url = (tag: string, name: string, value: string) => {
    if (placeholders && /^[\x00-\x20]*\{\{/.test(value)) return;
    if (/^[\x00-\x20]*(?:#|$)/.test(value) || /^[\x00-\x20]*cid:/i.test(value)) return;
    const target = destination(value);
    if (target) destinations.add(target);
    else refuse(`<${tag} ${name}> that is not an absolute http(s), mailto or tel address`);
  };
  const walk = (node: HtmlNode) => {
    const tag = node.tagName?.toLowerCase();
    if (tag === 'base') refuse('<base>');
    if (tag === 'link') refuse('<link>');
    if (tag && PLUGINS.has(tag)) refuse(`<${tag}>`);
    if (tag === 'meta' && node.attrs?.some(a => a.name === 'http-equiv' && /^\s*(?:refresh|link)\s*$/i.test(a.value))) refuse('<meta http-equiv="refresh"> or <meta http-equiv="link">');
    if (tag && ANIMATIONS.has(tag) && node.namespaceURI === SVG) {
      const target = node.attrs?.find(a => a.name === 'attributeName')?.value.trim().toLowerCase() ?? '';
      if (isUrlAttribute(target) || isUrlAttribute(target.replace(/^[^:]*:/, '')) || CSS_ATTRIBUTES.has(target)) refuse(`<${node.tagName} attributeName="${target}">`);
    }
    if (tag === 'style') {
      const css = textOf(node), fonts = fontSheet(css);
      if (fonts) for (const font of fonts) destinations.add(new URL(font).href);
      else if (cssResource(css)) refuse('a url(), image-set() or @import in a <style> sheet');
    }
    if (tag) for (const a of node.attrs ?? []) {
      const name = a.prefix ? `${a.prefix}:${a.name}` : a.name;
      if (name === 'style') {
        const { urls, rest } = styleResources(a.value);
        for (const target of urls) url(tag, 'style', target);
        if (cssResource(rest)) refuse(`a url(), image-set() or @import in <${tag} style> other than background-image: url("https://…")`);
      } else if (CSS_ATTRIBUTES.has(name) && cssResource(a.value)) refuse(`a url() in <${tag} ${name}>`);
      if (!isUrlAttribute(name)) continue;
      if (REFUSED.has(name)) refuse(`<${tag} ${name}>`);
      else if (URL_LISTS.has(name)) for (const token of a.value.split(/[\t\n\f\r ]+/).filter(Boolean)) url(tag, name, token);
      else url(tag, name, a.value);
    }
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  for (const root of roots) walk(root);
  return { destinations, unsupported };
}
export async function readHtml(html: string, visit?: (tag: string) => void, options: { placeholders?: boolean } = {}) {
  const { boundedHtmlFragment } = await import('./bounded-html.js');
  if (html.length>512*1024) throw unreadable();
  const fragment=boundedHtmlFragment(html,'fragment',{clients:true});
  if (!fragment) throw unreadable();
  // A client given the whole message keeps the attributes of its <html> and <body>, which a fragment drops.
  const whole=boundedHtmlFragment(html,'document',{clients:true});
  if (!whole) throw unreadable();
  const { destinations, unsupported }=inventory([fragment, whole] as unknown as HtmlNode[], options.placeholders);
  const hosts=new Set([...destinations].map(destinationHost).filter(Boolean)), mismatches=new Set<string>(), links:string[]=[], images:{ alt: boolean }[]=[];
  // Text as a client lays it out: inline runs stay one word, block elements end the line, and text a client shows
  // beside the flow (alt, title) follows on its own lines, as does a table row whose cells hold short pieces read
  // glued, the way a recipient reads a word laid out across adjacent cells.
  const lines:string[]=[], aside:string[]=[], rows:string[][]=[]; let line='';
  const flush=()=>{ if(line.trim()) lines.push(line); line=''; };
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
    if (['style','script','template','head','title','xml'].includes(tag)) return;
    let display='';
    for (const a of node.attrs) {
      // URLs are read from the decoded attribute as they are, never as prose (the inventory above has them all).
      if (tag==='a' && a.name==='href') { const target=destination(a.value); anchor=target ? destinationHost(target) : ''; if (target) links.push(target); }
      if (a.name==='style') display=/(?:^|;)\s*display\s*:\s*([a-z-]+)/i.exec(a.value)?.[1]?.toLowerCase() ?? '';
      if (['alt','title'].includes(a.name) && a.value.trim()) aside.push(a.value);
    }
    if (tag==='img') images.push({ alt: node.attrs.some(a=>a.name==='alt' && !!a.value.trim()) });
    const inline=display ? display.startsWith('inline') : INLINE.has(tag);
    if (!inline) flush();
    const start=lines.length;
    if (tag==='tr') rows.push([]);
    for (const child of children) walk(child,anchor);
    if (!inline) flush();
    if (tag==='td' || tag==='th') rows[rows.length-1]?.push(lines.slice(start).join(' '));
    if (tag==='tr') { const cells=rows.pop()!; if (cells.length>1 && cells.some(cell=>cell.trim() && cell.trim().length<=4)) aside.push(cells.join('')); }
  };
  for (const child of fragment.childNodes) walk(child,'');
  flush();
  return { text: [...lines,...aside].join('\n'), hosts, mismatches, destinations, unsupported, links, images };
}
/**
 * The text the screen reads: the HTML's visible text, then the text part, then raw MIME, each in full. A recipient reads
 * one part or the other, so a part is left out only when, normalized, it is byte for byte a part already read (a text part
 * generated from the HTML); any difference at all, and the whole part is screened. The parts' word overlap goes to the
 * classifier as a signal, since a text part that tells another story is a known spam trick.
 */
export function screenTextSignals(visible: string, text?: string, rawPart?: string) {
  const project=(s='')=>normalize(s).replace(/\s+/g,' ').trim();
  const rendered=project(visible), plain=project(text), raw=project(rawPart);
  const words=(v:string)=>new Set(v.toLowerCase().match(VISIBLE_WORDS));
  function overlap(text:string, html:string) {
    const a=words(text), b=words(html), common=[...a].filter(w=>b.has(w)).length;
    return a.size && b.size ? common/(a.size+b.size-common) : undefined;
  }
  const parts=[rendered,plain,raw].filter((part,i,all)=>part && all.indexOf(part)===i);
  return { content:parts.join('\n'), textHtmlOverlap:overlap(plain,rendered) };
}
export type ScreenMeasure = { read?: Awaited<ReturnType<typeof readHtml>>; signals: string[]; destinations: string[]; unsupported: string[]; content: string; textHtmlOverlap?: number; screenedBytes: number };
/**
 * What the screen would read of a message, measured without asking the classifier: its text, then every distinct
 * place it links to or loads from, canonical and in full (links, images and other resources, and addresses in its
 * text), one per line. Destinations count toward the screened-text limit like the text: none is dropped to fit.
 */
export async function measureScreen(snapshot: Pick<EmailSnapshot, 'html' | 'text' | 'raw'>, options: { placeholders?: boolean } = {}): Promise<ScreenMeasure> {
  const read=snapshot.html ? await readHtml(snapshot.html, undefined, options) : undefined;
  const destinations=[...new Set([...read?.destinations ?? [], ...[read?.text, snapshot.text, snapshot.raw].flatMap(part => textTargets(part)).flatMap(target => destination(target) ?? [])])];
  const hosts=new Set([...read?.hosts ?? [], ...destinations.map(destinationHost).filter(Boolean)]);
  const signals=[...read?.mismatches ?? [], ...hosts];
  const text=screenTextSignals(read?.text ?? '',snapshot.text,snapshot.raw), content=[text.content, destinations.join('\n')].filter(Boolean).join('\n');
  return { read, signals, destinations, unsupported: read?.unsupported ?? [], content, textHtmlOverlap: text.textHtmlOverlap, screenedBytes: Buffer.byteLength(content) };
}
/** Refuses a message the screen cannot read within a limit, with the measured size; `index` names a batch item. */
export function assertScreenable(measure: ScreenMeasure, limitBytes: number, scope: 'message' | 'campaign' = 'message', index?: number) {
  if (measure.unsupported.length) throw unsupportedUrls(measure.unsupported, index);
  if (measure.signals.length>MAX_SIGNALS || Buffer.byteLength(measure.signals.join('\n'))>MAX_SIGNAL_BYTES) throw tooManyHosts(measure.signals.length,index);
  if (measure.screenedBytes>limitBytes) throw tooLarge(measure.screenedBytes,limitBytes,scope,index);
}
async function body(snapshot: EmailSnapshot, limitBytes: number) {
  const measure=await measureScreen(snapshot);
  assertScreenable(measure,limitBytes);
  return { bodies:completeBodies(measure.content,measure.signals.join('\n'),limitBytes), textHtmlOverlap:measure.textHtmlOverlap };
}
export async function jevQuestions(endpoint:string,apiKey:string,model:string,state:unknown,questions:unknown,deadline:number):Promise<unknown> {
  // The deadline includes reading the response body. Never retry inside a send lease.
  let response: Response;
  try {
    response = await fetch(endpoint, {
      // Never follow a redirect: the key and the message body go only to the configured endpoint. Workers
      // reject redirect: 'error', so use 'manual'; a 3xx is not ok and counts as unavailable below.
      method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, state, questions }), signal: AbortSignal.timeout(deadline),
    });
  } catch {
    throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'The content classifier could not be reached.', undefined, true);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', `The content classifier failed with HTTP ${response.status}.`, undefined, true);
  }
  const reader=response.body?.getReader(); if(!reader)return null;
  const chunks:Uint8Array[]=[];let bytes=0;for(;;){const {value,done}=await reader.read();if(done)break;if((bytes+=value.length)>32768){await reader.cancel();return null}chunks.push(value)}
  try{return JSON.parse(Buffer.concat(chunks).toString())}catch{return null}
}
async function evaluate(endpoint: string, apiKey: string, model: string, state: unknown): Promise<ScreenResult> {
  const parsed = await jevQuestions(endpoint,apiKey,model,state,QUESTIONS,DEADLINE_MS) as { model?: unknown; answers?: { spam?: { noul?: unknown } } } | null;
  const spam = parsed?.answers?.spam?.noul;
  if (typeof spam !== 'number' || !Number.isFinite(spam) || spam<0 || spam>1) throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'The content classifier returned no valid spam score.', undefined, true);
  return { spam, model: typeof parsed?.model === 'string' ? parsed.model : model };
}

/** Spam probability for one snapshot, or null when the installation has no classifier configured. A campaign test has
 *  the campaign limit. `reserve` is told how many requests a classification will make before the first one. */
export async function screenSnapshot(runtime: Runtime, snapshot: EmailSnapshot, required=false, reserve?: (requests: number) => Promise<void>): Promise<ScreenResult | null> {
  const settings = runtime.config.screen;
  if (!settings) return null;
  const from = formattedSender(snapshot.from, snapshot.fromName);
  const recipients=snapshot.to.length+snapshot.cc.length+snapshot.bcc.length;
  const key = await digest(JSON.stringify([runtime.config.workspaceId,settings.endpoint,settings.model,required,from,snapshot.kind,snapshot.subject,snapshot.text,snapshot.html,snapshot.raw,recipients]));
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.result;
  if (hit) cache.delete(key);
  // Concurrent copies share one request; failures are not cached so the next copy retries.
  let pending=flights.get(runtime.storage);if(!pending){pending=new Map();flights.set(runtime.storage,pending);}
  const existing=pending.get(key);if(existing)return existing;
  const limits=runtime.config.screenLimits;
  const lookup=body(snapshot,snapshot.testCampaignId ? limits.campaignBytes : limits.messageBytes).then(async ({bodies,textHtmlOverlap})=>{
    await reserve?.(bodies.length);
    const sender=copy(from), subject=copy(snapshot.subject);
    let highest: ScreenResult | undefined;
    for (const body of bodies) {
      const result=await evaluate(settings.endpoint,settings.apiKey,settings.model,{email:{from:required?sender:sender.slice(0,100),kind:snapshot.kind,subject:required?subject:subject.slice(0,200),body},signals:{recipients,textHtmlOverlap}});
      if (!highest || result.spam>highest.spam) highest=result;
    }
    return highest!;
  });pending.set(key,lookup);
  try{const result=await lookup;cache.set(key,{expires:now+TTL_MS,result});
    while(cache.size>MAX_ENTRIES)cache.delete(cache.keys().next().value!);return result;
  }finally{pending.delete(key);}
}

// A Hosted campaign is screened copy by copy, as single messages are, but each distinct copy only once
// (src/sending.ts campaignVerdicts): a copy's verdict is keyed by its exact screen input, everything the classifier is
// sent for it, so recipients whose copies read the same share it. Only the generated unsubscribe link is set aside.

/** A campaign's screening state, on its review (sending_campaign_reviews.screen). */
export type CampaignScreen = {
  /** The review content it belongs to (sending_campaign_reviews.content_hash). */
  contentHash: string; probation: boolean;
  /** The campaign's own copy, placeholders unresolved, screened first as an early refusal. */
  template: { key: string; spam: number; model: string } | null;
  /** Recipients whose copies have verdicts, in send order, and how many of them were refused as spam. */
  screenedThrough: number; recipients: number; rejected: number;
  /** Classifier outages in a row, for the wait before the next attempt; whether the refused share paused it once. */
  failures: number; quarantined: boolean;
};
/** What the classifier is sent for one copy: its requests, and their key, which is the same for the same input. */
export type ScreenInput = { key: string; bodies: string[]; textHtmlOverlap?: number; from: string; subject: string };
/** A campaign copy's screen input, refused past the limit. */
export async function screenInput(runtime: Runtime, snapshot: EmailSnapshot, limitBytes: number, options: { placeholders?: boolean } = {}): Promise<ScreenInput> {
  const settings = runtime.config.screen;
  if (!settings) throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'Hosted content screening is unavailable.', undefined, true);
  const measure = await measureScreen(snapshot, options);
  assertScreenable(measure, limitBytes, 'campaign');
  const bodies = completeBodies(measure.content, measure.signals.join('\n'), limitBytes, 'campaign');
  const from = copy(formattedSender(snapshot.from, snapshot.fromName)), subject = copy(snapshot.subject);
  const key = await digest(JSON.stringify([settings.endpoint, settings.model, from, snapshot.kind, subject, bodies, measure.textHtmlOverlap ?? null]));
  return { key, bodies, textHtmlOverlap: measure.textHtmlOverlap, from, subject };
}
/** One request of a campaign copy's screen. */
export async function screenWindow(runtime: Runtime, input: ScreenInput, window: number): Promise<ScreenResult> {
  const settings = runtime.config.screen;
  if (!settings) throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'Hosted content screening is unavailable.', undefined, true);
  return evaluate(settings.endpoint, settings.apiKey, settings.model, { email: { from: input.from, kind: 'marketing', subject: input.subject, body: input.bodies[window]! }, signals: { recipients: 1, textHtmlOverlap: input.textHtmlOverlap } });
}
