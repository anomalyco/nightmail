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
// A sentence's words, so the same sentence matches whatever its case, spacing or closing punctuation. Punctuation inside
// a word stays part of it (pills.biz is not "pills biz"), and a sentence without words (emoji, symbols) keeps its text.
const sentenceKey = (sentence: string) => sentence.toLowerCase().match(/[\p{L}\p{N}]+(?:[.@/:_'’-][\p{L}\p{N}]+)*/gu)?.join(' ') || sentence;
/**
 * The text the screen reads: the HTML's visible text in order with its repetitions, then each sentence of the text part
 * (and of raw MIME) the HTML doesn't already say. A recipient reads one part or the other, so a sentence both parts say
 * word for word is screened once; anything the text part says differently is screened, and the word overlap of the two
 * parts goes to the classifier as a signal, since a text part that tells another story is a known spam trick.
 */
export function screenTextSignals(visible: string, text?: string, rawPart?: string) {
  const project=(s='')=>normalize(s).replace(/\s+/g,' ').trim();
  const plain=project(text), rendered=project(visible);
  const said=new Set(sentences(visible).map(sentenceKey));
  // In order and with their repetitions, as the HTML's text: only what an earlier part already said is left out.
  const unsaid=(part?:string)=>{
    const kept=sentences(part).filter(sentence=>!said.has(sentenceKey(sentence)));
    for (const sentence of kept) said.add(sentenceKey(sentence));
    return kept.join(' ');
  };
  const words=(v:string)=>new Set(v.toLowerCase().match(VISIBLE_WORDS));
  function overlap(text:string, html:string) {
    const a=words(text), b=words(html), common=[...a].filter(w=>b.has(w)).length;
    return a.size && b.size ? common/(a.size+b.size-common) : undefined;
  }
  const textPart=unsaid(text);
  return { content:[rendered,textPart,unsaid(rawPart)].filter(Boolean).join('\n'), textHtmlOverlap:overlap(plain,rendered) };
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

/** Spam probability for one snapshot, or null when the installation has no classifier configured. */
export async function screenSnapshot(runtime: Runtime, snapshot: EmailSnapshot, required=false): Promise<ScreenResult | null> {
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
  const lookup=body(snapshot,runtime.config.screenLimits.messageBytes).then(async ({bodies,textHtmlOverlap})=>{
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

// A campaign is screened once, not once per recipient (src/sending.ts screenCampaignStep): its own copy with the
// placeholders unresolved, then every distinct personalization value of its frozen audience, packed into as few requests
// as fit. The verdict lives on the immutable review it judged; an edit is a new review and is screened again. Per
// recipient the dispatcher only checks, locally, that the copy says nothing the screen did not read: each value within
// the rules below, and every host the copy links to or loads among those the campaign links to or the sender verified.

/** A campaign's verdict, stored on its review (sending_campaign_reviews.screen). */
export type CampaignScreen = {
  /** The review content it judged (sending_campaign_reviews.content_hash) and the copy it read. */
  contentHash: string; probation: boolean; model: string; spam: number; calls: number; screenedBytes: number;
  /** Hosts the campaign's own copy links to or loads, its link labels naming another host, and the verified domains. */
  hosts: string[]; mismatches: string[]; domains: string[];
  /** Distinct personalization values screened so far (the last one, in byte order), and whether all were. */
  cursor: string | null; values: number; done: boolean;
};
export const MAX_MERGE_VALUE_BYTES = 256;
const URLS = /(?:\bhttps?:\/\/|(?<![\w.-])\/\/|\bwww\.)[^\s<>"'()]+|\bmailto:[^\s<>"'()]+/gi;
export const allowedHost = (name: string, screen: Pick<CampaignScreen, 'hosts' | 'domains'>) => screen.hosts.includes(name) || screen.domains.some(domain => name === domain || name.endsWith('.' + domain));
/** Why a personalization value can't go out under its campaign's verdict, or null: at most 256 bytes, no control or
 *  reordering characters, no markup, and links only to hosts the campaign already links to or the sender verified. */
export function mergeValueProblem(value: string, screen: Pick<CampaignScreen, 'hosts' | 'domains'>): string | null {
  const size = Buffer.byteLength(value);
  if (size > MAX_MERGE_VALUE_BYTES) return `is ${bytes(size)} bytes; screened campaigns accept values up to ${MAX_MERGE_VALUE_BYTES} bytes`;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)) return 'contains control characters';
  if (/[\u202a-\u202e\u2066-\u2069]/.test(value)) return 'contains characters that reorder text';
  if (/<[a-z/!?]/i.test(value)) return 'contains HTML';
  for (const [match] of normalize(value).matchAll(URLS)) {
    const target = /^mailto:/i.test(match) ? match.slice(match.lastIndexOf('@') + 1).split(/[?#]/)[0]!.toLowerCase() : host(/^www\./i.test(match) ? 'https://' + match : match);
    if (!target || !allowedHost(target, screen)) return `links to ${target || 'an unreadable address'}, which the campaign doesn't link to and isn't a verified sending domain`;
  }
  return null;
}
const unscreened = (why: string) => new ApiError(422, 'CAMPAIGN_CONTENT_UNSCREENED', `This recipient's copy says what the campaign screen did not read: ${why}`);
/** One recipient's copy against its campaign's verdict, without the classifier. */
export async function checkCampaignCopy(snapshot: Pick<EmailSnapshot, 'html'>, values: [string, string][], screen: CampaignScreen) {
  for (const [key, value] of values) { const problem = mergeValueProblem(value, screen); if (problem) throw unscreened(`the value for {{${key}}} ${problem}.`); }
  if (!snapshot.html) return;
  const read = await readHtml(snapshot.html);
  for (const name of read.hosts) if (!allowedHost(name, screen)) throw unscreened(`it links to or loads ${name}.`);
  // A label that is a domain name (not "Inc." or "St.") naming another host than its link, which the campaign's own copy didn't.
  for (const mismatch of read.mismatches) {
    const [label] = mismatch.split(' → ');
    if (!screen.mismatches.includes(mismatch) && /[^.]\.[^.]/.test(label!)) throw unscreened(`a link labelled ${label} goes elsewhere.`);
  }
}
/** The campaign's own copy as screen requests, refused past the campaign limit. */
export function campaignBodies(measure: ScreenMeasure, limitBytes: number) {
  assertScreenable(measure, limitBytes, 'campaign');
  return completeBodies(measure.content, measure.signals.join('\n'), limitBytes, 'campaign');
}
/** Personalization values as screen requests: each value whole, after the campaign's link signals, filling the copy's
 *  last request first. */
export function packValues(bodies: string[], signals: string[], values: string[]) {
  const out = [...bodies], prefix = signals.length ? signals.join('\n') + '\n' : '';
  let room = out.length ? MAX_BODY - Buffer.byteLength(out.at(-1)!) : -1;
  for (const value of values) {
    const line = normalize(value).replace(/\s+/g, ' ').trim(), size = Buffer.byteLength(line) + 1;
    if (!line) continue;
    if (size > room) { out.push(prefix + line); room = MAX_BODY - Buffer.byteLength(out.at(-1)!); continue; }
    out[out.length - 1] += '\n' + line; room -= size;
  }
  return out;
}
/** The highest spam score over a campaign's requests, four at a time. */
export async function screenCampaignBodies(runtime: Runtime, head: Pick<EmailSnapshot, 'from' | 'fromName' | 'subject'>, bodies: string[], textHtmlOverlap?: number): Promise<ScreenResult> {
  const settings = runtime.config.screen;
  if (!settings) throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'Hosted content screening is unavailable.', undefined, true);
  const from = copy(formattedSender(head.from, head.fromName)), subject = copy(head.subject);
  let highest: ScreenResult | undefined, next = 0;
  await Promise.all(Array.from({ length: Math.min(4, bodies.length) }, async () => {
    while (next < bodies.length) {
      const result = await evaluate(settings.endpoint, settings.apiKey, settings.model, { email: { from, kind: 'marketing', subject, body: bodies[next++]! }, signals: { recipients: 1, textHtmlOverlap } });
      if (!highest || result.spam > highest.spam) highest = result;
    }
  }));
  return highest!;
}
