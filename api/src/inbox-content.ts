import { boundedHtmlFragment } from './bounded-html.js';
import type { DefaultTreeAdapterMap } from 'parse5';

// Normalise the text shown to an agent, not the canonical MIME or stored headers.
export const displayText=(s:string)=>s.replace(/[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFFA0\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu,'');
function normalizedCss(value:string){
  return value.replace(/\/\*[\s\S]*?(?:\*\/|$)/g,'').replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi,(_,h,c)=>h?String.fromCodePoint(Math.min(0x10ffff,parseInt(h,16))):c).toLowerCase();
}
function hides(style:string){
  const css=normalizedCss(style);
  if(/(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|color\s*:\s*transparent|(?:clip|clip-path)\s*:|(?:text-indent|left|right|top|bottom)\s*:\s*-\d{2,}|(?:width|height)\s*:\s*0(?:[a-z%]+)?\s*(?:;|!|$))/.test(css))return true;
  for(const m of css.matchAll(/(?:font-size|opacity)\s*:\s*(\d*\.?\d+)\s*([a-z%]*)/g)){
    const n=Number(m[1]);if(m[0].startsWith('opacity')?n<(m[2]==='%'?10:.1):n===0||m[2]==='px'&&n<2)return true;
  }
  const color=(property:string)=>new RegExp('(?:^|[;{])\\s*'+property+'\\s*:\\s*([^;!}]+)').exec(css)?.[1].trim().replace(/\s+/g,'').replace(/^(?:white|#fff|rgb\(255,255,255\))$/,'#ffffff');
  const fg=color('color');return !!fg && (fg===(color('background-color')??color('background')) || fg==='#ffffff');
}
/** HTML is parsed locally and never rendered, visited, or treated as instructions. */
export function visibleMail(text: string | null, html: string | null, extract = '') {
  let hiddenContent = false;
  const strip=(s:string)=>{const out=displayText(s);if(out!==s)hiddenContent=true;return out;};
  const links: { text: string; href: string; mismatch: boolean }[] = [];
  function walk(n: DefaultTreeAdapterMap['childNode']): string {
    if (n.nodeName === '#text' && 'value' in n) return strip(n.value);
    // An Outlook conditional comment ([if mso], or [if !mso]><!-- that reveals markup to everyone else, cut short or
    // not) shows Outlook other markup than this reads: flagged, never read as text.
    if (!('tagName' in n)) { if ('data' in n && /^\[if\b/i.test(n.data.trim())) hiddenContent = true; return ''; }
    const attr = (k: string) => n.attrs.find((a) => a.name === k)?.value;
    if (
      // A frame shows another document (or its srcdoc), and a client that plays or embeds the element shows none of its fallback text.
      ['script', 'style', 'template', 'noscript', 'head', 'title', 'svg', 'math', 'iframe', 'noembed', 'noframes', 'object', 'applet', 'canvas', 'audio', 'video'].includes(n.tagName) || (n.tagName==='details' && attr('open')===undefined) || (hasStylesheet && (attr('class')!==undefined || attr('id')!==undefined)) ||
      attr('hidden') !== undefined ||
      attr('aria-hidden') === 'true' ||
      hides(attr('style')??'')
    ) {
      hiddenContent = true;
      return '';
    }
    const s = n.childNodes.map(walk).join('');
    if (n.tagName === 'a' && links.length < 20 && extract.includes('links')) {
      try {
        const url = new URL(attr('href') ?? '');
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
          const claimed = s.trim().match(/^(?:https?:\/\/)?([\w-]+(?:\.[\w-]+)+)(?:[/:?#]|$)/i)?.[1];
          links.push({ text: s.trim(), href: url.href, mismatch: !!claimed && claimed.toLowerCase() !== url.hostname });
        }
      } catch {
        /* Not an absolute web link. */
      }
    }
    return ['div', 'p', 'br', 'li', 'tr'].includes(n.tagName) ? `\n${s}\n` : s;
  }
  const fragment = html ? boundedHtmlFragment(html) : null;
  // No CSS engine: when a stylesheet exists, conservatively omit class/id-styled subtrees
  // rather than trusting text whose visibility depends on the cascade. Never fetch CSS.
  const hasStylesheet=!!html && /<(?:style|link)\b/i.test(html);if(hasStylesheet)hiddenContent=true;
  const visible = fragment ? fragment.childNodes.map(walk).join('') : strip(text ?? '');
  if (html && !fragment) hiddenContent = true;
  const PLAIN_URL = /\bhttps?:\/\/[^\s<>"'`]+/gi;
  if (extract.includes('links') && links.length < 20) {
    const seen = new Set(links.map(l => l.href));
    for (const match of visible.matchAll(PLAIN_URL)) {
      if (links.length >= 20) break;
      let raw = match[0];
      while (raw.length > 8) {
        const last = raw[raw.length - 1]!;
        if ('.,;:!?\'"'.includes(last)) { raw = raw.slice(0, -1); continue; }
        if (last === ')' && (raw.match(/\)/g)?.length ?? 0) > (raw.match(/\(/g)?.length ?? 0)) { raw = raw.slice(0, -1); continue; }
        if (last === ']' && (raw.match(/\]/g)?.length ?? 0) > (raw.match(/\[/g)?.length ?? 0)) { raw = raw.slice(0, -1); continue; }
        if (last === '}' && (raw.match(/\}/g)?.length ?? 0) > (raw.match(/\{/g)?.length ?? 0)) { raw = raw.slice(0, -1); continue; }
        break;
      }
      try {
        const url = new URL(raw);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !seen.has(url.href)) {
          seen.add(url.href);
          links.push({ text: raw, href: url.href, mismatch: false });
        }
      } catch {
        /* Not an absolute web link. */
      }
    }
  }
  const codes = new Set<string>();
  if (extract.includes('codes')) {
    const codeText = visible.replace(PLAIN_URL, ' ');
    for (const kw of codeText.matchAll(/\b(?:code|verification|verify|otp|passcode|one[- ]time|pin)\b/gi)) {
      const around = codeText.slice(Math.max(0, kw.index! - 80), kw.index! + kw[0].length + 80);
      for (const m of around.matchAll(/\b[A-Z0-9]{4,10}\b/gi))
        if (/\d/.test(m[0])) {
          codes.add(m[0]);
          if (codes.size === 5) break;
        }
      if (codes.size === 5) break;
    }
  }
  return { text: visible.trim(), hiddenContent, extract: { codes: [...codes], links } };
}
/** Visible plain text of a stored message: invisible Unicode stripped from plain text, or CSS-hidden HTML and invisible Unicode stripped when there is no plain text. */
export function safeMailText(text: string | null | undefined, html: string | null | undefined): { text: string; hiddenContent: boolean } {
  if (text != null) {
    const cleaned = displayText(text);
    return { text: cleaned, hiddenContent: cleaned !== text };
  }
  if (!html) return { text: '', hiddenContent: false };
  const visible = visibleMail(null, html);
  return { text: visible.text, hiddenContent: visible.hiddenContent };
}
