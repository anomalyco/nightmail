import { ApiError, digest, type Runtime } from './core.js';
import type { EmailSnapshot } from './db/sending.js';
import { VISIBLE_WORDS } from './screened-html.js';
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
const sentences = (s = '') => normalize(s).split(/\n+|(?<=[.!?])\s+/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
function copy(s = '') {
  return [...new Set(sentences(s))].join(' ');
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
  refused(`The screened text is ${bytes(screenedBytes)} UTF-8 bytes; Hosted sending screens at most ${bytes(limitBytes)} per ${scope}. It counts the HTML's visible text and alt text, and each text-part sentence the HTML doesn't already say. Shorten the copy by ${bytes(screenedBytes - limitBytes)} bytes.`,
    { screenedBytes, limitBytes }, index);
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
      if (['href','src','srcset','background','action','style'].includes(a.name)) {
        for(const m of normalize(a.value).matchAll(/(?:https?:)?\/\/[^\s,)'"<>]+/gi)) { const h=host(m[0]); if(h) hosts.add(h); }
        if(tag==='a' && a.name==='href') { anchor=host(normalize(a.value)); links.push(normalize(a.value)); }
      }
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
  return { text: [...lines,...aside].join('\n'), hosts, mismatches, links, images };
}
/**
 * The text the screen reads: the HTML's visible text in order with its repetitions, then the text part (and raw MIME)
 * without the sentences that only repeat the HTML. A recipient reads one part or the other, so a sentence is left out
 * only when it is exactly a sentence of the HTML once normalized (punctuation, links and case kept), and only in the
 * HTML's order: whatever the text part says differently, or says in another order, is screened. The parts' word overlap
 * still goes to the classifier as a signal, since a text part that tells another story is a known spam trick.
 */
export function screenTextSignals(visible: string, text?: string, rawPart?: string) {
  const project=(s='')=>normalize(s).replace(/\s+/g,' ').trim();
  const plain=project(text), rendered=project(visible), html=sentences(visible);
  const at=new Map<string,number[]>();
  html.forEach((sentence,i)=>at.set(sentence,[...at.get(sentence)??[],i]));
  // Each part walks the HTML's sentences forward: a sentence is a repeat only at or after the previous repeat. A line
  // break inside a paragraph of a plain part (hard wrapping) is a space; a blank line ends a sentence.
  const unsaid=(part?:string)=>{
    let next=0; const kept:string[]=[];
    for (const sentence of sentences(part?.replace(/\r\n?/g,'\n').replace(/([^\n])\n(?=[^\n])/g,'$1 '))) {
      const places=at.get(sentence); let lo=0, hi=places?.length ?? 0;
      while (lo<hi) { const mid=(lo+hi)>>1; if (places![mid]!<next) lo=mid+1; else hi=mid; }
      if (places && lo<places.length) next=places[lo]!+1; else kept.push(sentence);
    }
    return kept.join(' ');
  };
  const words=(v:string)=>new Set(v.toLowerCase().match(VISIBLE_WORDS));
  function overlap(text:string, html:string) {
    const a=words(text), b=words(html), common=[...a].filter(w=>b.has(w)).length;
    return a.size && b.size ? common/(a.size+b.size-common) : undefined;
  }
  return { content:[rendered,unsaid(text),unsaid(rawPart)].filter(Boolean).join('\n'), textHtmlOverlap:overlap(plain,rendered) };
}
export type ScreenMeasure = { read?: Awaited<ReturnType<typeof readHtml>>; signals: string[]; content: string; textHtmlOverlap?: number; screenedBytes: number };
/** What the screen would read of a message, measured without asking the classifier. */
export async function measureScreen(snapshot: Pick<EmailSnapshot, 'html' | 'text' | 'raw'>): Promise<ScreenMeasure> {
  const read=snapshot.html ? await readHtml(snapshot.html) : undefined;
  const signals=read ? [...read.mismatches,...read.hosts] : [];
  const {content,textHtmlOverlap}=screenTextSignals(read?.text ?? '',snapshot.text,snapshot.raw);
  return { read, signals, content, textHtmlOverlap, screenedBytes: Buffer.byteLength(content) };
}
/** Refuses a message the screen cannot read within a limit, with the measured size; `index` names a batch item. */
export function assertScreenable(measure: ScreenMeasure, limitBytes: number, scope: 'message' | 'campaign' = 'message', index?: number) {
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

// A campaign is screened once, not once per recipient (src/sending.ts screenCampaignStep), only when personalization
// can't change what it says. Its placeholders must sit where a value reads as a word of its own (text and subject, never
// joined to the text or another placeholder beside them) or as a whole query value of a link, and every value of its
// frozen audience must be inert: a short run of letters, digits and name punctuation, or a link token. The classifier
// then reads the campaign's copy with its placeholders and a sample of assembled copies, and the dispatcher delivers a
// copy under that verdict only when it is the template with values in its slots and nothing else. Every other campaign
// is screened per recipient, within a budget fixed by its audience.

/** A campaign's verdict, stored on its review (sending_campaign_reviews.screen). */
export type CampaignScreen = {
  /** The review content it judged (sending_campaign_reviews.content_hash), and when. */
  contentHash: string; at: string;
  /** once: inert values; the copy and sample were screened. each: every recipient's copy is screened on its own. */
  mode: 'once' | 'each'; reason: string | null;
  probation: boolean; model: string; spam: number; calls: number; screenedBytes: number;
  /** Classifier requests allowed and spent screening single copies of this campaign. */
  budget: number; spent: number;
  /** The values pass: the last placeholder and value checked, the longest normalized value per placeholder. */
  cursor: [string, string] | null; longest: Record<string, number>; values: number; done: boolean;
};
export const SAMPLE_COPIES = 12, MAX_VALUE_CHARS = 64;
const TAG = /{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g, WHOLE_TAG = /^{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}$/;
/** Where a campaign's placeholders sit: as words of text, as whole link query values, how often. */
export type CampaignSlots = { text: string[]; token: string[]; occurrences: Record<string, number> };
// A link may carry a value only as a whole query value of a fixed http(s) address: never in its scheme, host, path,
// parameter names or fragment.
function querySlot(url: string, token: Set<string>): string | null {
  const query = url.indexOf('?'), hash = url.indexOf('#', query < 0 ? 0 : query);
  const base = url.slice(0, query < 0 ? (hash < 0 ? url.length : hash) : query);
  if (base.includes('{{') || (hash >= 0 && url.slice(hash).includes('{{'))) return 'a placeholder is part of a link address';
  if (!/^https?:\/\/[^/?#{}\s]+/i.test(base)) return 'a placeholder is in a link that is not an http(s) address';
  for (const param of url.slice(query + 1, hash < 0 ? undefined : hash).split('&')) {
    const eq = param.indexOf('='), name = eq < 0 ? param : param.slice(0, eq), value = eq < 0 ? '' : param.slice(eq + 1);
    if (name.includes('{{')) return 'a placeholder is a link parameter name';
    if (!value.includes('{{')) continue;
    const key = WHOLE_TAG.exec(value)?.[1];
    if (!key || key === 'email') return 'a placeholder is part of a link parameter value';
    token.add(key);
  }
  return null;
}
// In text a value must read as words of its own: whitespace, an opening bracket or quote before it; whitespace, closing
// punctuation, or a period or colon that ends the sentence after it; and a letter or digit of fixed text between two
// placeholders. Read after the screen's normalization, so an entity, a compatibility form or an invisible character
// can't join it to its neighbours.
const BEFORE = /[\s([{"'“‘«¿¡]/u, AFTER = /[\s,;!?)\]}"'”’»]/u;
function textSlots(stream: string, text: Set<string>, token: Set<string>, occurrences: Record<string, number>, links: boolean): string | null {
  const s = normalize(stream);
  let previous = -1;
  for (const match of s.matchAll(TAG)) {
    const key = match[1]!, start = match.index!, end = start + match[0].length;
    if (previous >= 0 && !/[\p{L}\p{N}]/u.test(s.slice(previous, start))) return `{{${key}}} follows another placeholder with no text between them`;
    previous = end; occurrences[key] = (occurrences[key] ?? 0) + 1;
    // The plain-text part prints links: a placeholder there is a link's query value or a word, as in the HTML.
    const word = s.slice(s.slice(0, start).search(/\S*$/), end + (s.slice(end).match(/^\S*/)?.[0].length ?? 0)).replace(/^[([<"']+|[)\]>"'.,;:!?]+$/g, '');
    if (links && /^(?:https?:\/\/|www\.)/i.test(word)) { const problem = querySlot(word, token); if (problem) return problem; continue; }
    const before = s[start - 1], after = s[end], next = s[end + 1];
    if (before !== undefined && !BEFORE.test(before)) return `{{${key}}} is joined to the text before it`;
    if (after !== undefined && !AFTER.test(after) && !((after === '.' || after === ':') && (next === undefined || /\s/.test(next)))) return `{{${key}}} is joined to the text after it`;
    text.add(key);
  }
  return null;
}
/** Where a campaign's placeholders sit, or why its values could change what it says (then it is screened per recipient). */
export async function campaignSlots(template: { subject: string; html?: string; text?: string }): Promise<CampaignSlots | string> {
  const text = new Set<string>(), token = new Set<string>(), occurrences: Record<string, number> = {};
  const subject = textSlots(template.subject, text, token, {}, false);
  if (subject) return `In the subject, ${subject}`;
  if (template.html) {
    const { boundedHtmlFragment } = await import('./bounded-html.js');
    const root = boundedHtmlFragment(template.html, 'document', { clients: true });
    if (!root) return 'The HTML is too large to read';
    const stack: unknown[] = [root];
    while (stack.length) {
      const node = stack.pop() as { attrs?: { name: string; value: string }[]; childNodes?: unknown[]; content?: unknown };
      for (const attr of node.attrs ?? []) {
        if (!attr.value.includes('{{')) continue;
        if (attr.name !== 'href') return `A placeholder is in a ${attr.name} attribute`;
        const problem = querySlot(attr.value.trim(), token);
        if (problem) return `In a link, ${problem}`;
      }
      stack.push(...node.childNodes ?? []);
      if (node.content) stack.push(node.content);
    }
    const problem = textSlots((await readHtml(template.html)).text, text, token, occurrences, false);
    if (problem) return `In the HTML, ${problem}`;
  }
  const plain = textSlots(template.text ?? '', text, token, occurrences, true);
  if (plain) return `In the text part, ${plain}`;
  return { text: [...text], token: [...token], occurrences };
}
/** Why a value can change what a campaign says in its slot, or null when it is inert: as a link token, 1–64 ASCII
 *  letters, digits, _ or -; as words, at most 64 characters after NFKC normalization of letters, digits, spaces and
 *  ' ’ , - with a period only at the end of a word, starting with a letter or digit. No line breaks, links or symbols. */
export function valueProblem(value: string, slots: { text: boolean; token: boolean }): string | null {
  if (slots.token && !/^[A-Za-z0-9_-]{1,64}$/.test(value)) return 'is not a link token';
  if (!slots.text) return null;
  const v = value.normalize('NFKC');
  if ([...v].length > MAX_VALUE_CHARS) return `is longer than ${MAX_VALUE_CHARS} characters`;
  if (!/^[\p{L}\p{M}\p{N} '’.,-]*$/u.test(v)) return 'has characters other than letters, digits, spaces and name punctuation';
  if (/\.(?! |$)/.test(v)) return 'has a period inside a word';
  if (v && !/^[\p{L}\p{N}]/u.test(v)) return 'does not start with a letter or digit';
  return null;
}
/** The normalized size of a value as the screen counts it. */
export const valueBytes = (value: string) => Buffer.byteLength(normalize(value));
/** What a delivered copy is compared with: the campaign's copy with its placeholders, as the screen reads it. */
export type CampaignTemplate = { subject: string; text: string; read: { text: string; links: string[] } };
export async function campaignTemplate(copy: Pick<EmailSnapshot, 'subject' | 'html' | 'text'>): Promise<CampaignTemplate> {
  const read = copy.html ? await readHtml(copy.html) : { text: '', links: [] };
  return { subject: copy.subject, text: copy.text ?? '', read: { text: read.text, links: read.links } };
}
/** Whether a delivered copy is its campaign's template with values in the slots and nothing else: the same subject,
 *  text part, visible text and links, the generated unsubscribe link aside. */
export async function sameOutsideSlots(copy: Pick<EmailSnapshot, 'subject' | 'html' | 'text'>, template: CampaignTemplate, values: Record<string, string>, unsubscribe?: { url: string; placeholder: string }) {
  const fill = (s: string) => s.replace(TAG, (_, key: string) => values[key] ?? '\u0000');
  const own = (s = '') => unsubscribe ? s.split(unsubscribe.url).join(unsubscribe.placeholder) : s;
  if (copy.subject !== fill(template.subject) || own(copy.text) !== fill(template.text)) return false;
  const read = copy.html ? await readHtml(own(copy.html)) : { text: '', links: [] };
  return read.text === fill(template.read.text) && read.links.length === template.read.links.length && read.links.every((link, i) => link === fill(template.read.links[i]!));
}
/** A campaign's requests: its copy's windows, up to the campaign limit. */
export function campaignBodies(measure: ScreenMeasure, limitBytes: number) {
  assertScreenable(measure, limitBytes, 'campaign');
  return completeBodies(measure.content, measure.signals.join('\n'), limitBytes, 'campaign');
}
/** The highest spam score over a campaign's requests, four at a time. */
export async function screenCampaignBodies(runtime: Runtime, head: Pick<EmailSnapshot, 'from' | 'fromName' | 'subject'>, requests: { body: string; subject: string; textHtmlOverlap?: number }[]): Promise<ScreenResult> {
  const settings = runtime.config.screen;
  if (!settings) throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'Hosted content screening is unavailable.', undefined, true);
  const from = copy(formattedSender(head.from, head.fromName));
  let highest: ScreenResult | undefined, next = 0;
  await Promise.all(Array.from({ length: Math.min(4, requests.length) }, async () => {
    while (next < requests.length) {
      const { body, subject, textHtmlOverlap } = requests[next++]!;
      const result = await evaluate(settings.endpoint, settings.apiKey, settings.model, { email: { from, kind: 'marketing', subject: copy(subject), body }, signals: { recipients: 1, textHtmlOverlap } });
      if (!highest || result.spam > highest.spam) highest = result;
    }
  }));
  return highest!;
}
