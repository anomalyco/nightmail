import SENDING_LIMITS from '../../../docs/sending-limits.md';
import RECEIVING from '../../../docs/receiving.md';
import RULES from '../../../docs/rules.md';
import INBOXES from '../../../docs/inboxes.md';
import MCP from '../../../docs/mcp.md';
import LIST_HYGIENE from '../../../docs/list-hygiene.md';
import SDK from '../../../sdk/README.md';
import { repositoryUrl } from '../../../api/src/brand.js';

// search_docs: the agent's search over Nightmail's published docs, the customer guides in the public repository
// (versioned with the code, read on GitHub at the production branch that nightmail.dev runs). They are bundled as text
// (wrangler's Text rule for *.md), so the index is what this deploy ships: no network, no model, no store. Only guides
// written for customers: never docs/'s runbooks, internal design notes or legal drafts. Each heading's section is one
// entry; a query's words rank them (BM25, the heading's words counting three times), and the best few come back as
// short excerpts with their links.

const SOURCES: { path: string; text: string }[] = [
  { path: 'docs/sending-limits.md', text: SENDING_LIMITS }, { path: 'docs/receiving.md', text: RECEIVING }, { path: 'docs/rules.md', text: RULES },
  { path: 'docs/inboxes.md', text: INBOXES }, { path: 'docs/mcp.md', text: MCP }, { path: 'docs/list-hygiene.md', text: LIST_HYGIENE }, { path: 'sdk/README.md', text: SDK },
];
/** Results per search, and an excerpt's length. */
const RESULTS = 3, EXCERPT = 700;
const STOP = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'my', 'of', 'on', 'or', 'our', 'so', 'that', 'the',
  'their', 'there', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your']);

/** Words, lower case, a plural's s dropped. */
const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(w => w.length > 1 && !STOP.has(w)).map(w => w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
/** Markdown as plain reading text: images and HTML comments gone, links as their words. */
const plain = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
/** GitHub's anchor for a heading: lower case, punctuation gone, spaces as hyphens; a repeat gets -1, -2. */
const slug = (heading: string) => heading.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');

type Entry = { path: string; page: string; section: string; anchor: string; body: string; terms: Map<string, number>; length: number };
let index: { entries: Entry[]; frequency: Map<string, number>; average: number } | null = null;

function build() {
  const entries: Entry[] = [];
  for (const { path, text } of SOURCES) {
    let page = path, section = '', anchor = '', body: string[] = [], fence = false;
    const seen = new Map<string, number>();
    const flush = () => {
      const content = plain(body.join('\n')).trim();
      if (content || section) {
        const terms = new Map<string, number>(), all = [...words(`${section} ${section} ${section} ${page}`), ...words(content)];
        for (const w of all) terms.set(w, (terms.get(w) ?? 0) + 1);
        entries.push({ path, page, section: section || page, anchor, body: content, terms, length: all.length });
      }
      body = [];
    };
    for (const line of text.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      const heading = !fence && /^(#{1,3})\s+(.+?)\s*#*$/.exec(line);
      if (!heading) { body.push(line); continue; }
      flush();
      const title = heading[2]!.replace(/`/g, '');
      if (heading[1] === '#' && page === path) { page = title; section = ''; anchor = ''; continue; }
      const base = slug(title), n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      section = title; anchor = n ? `${base}-${n}` : base;
    }
    flush();
  }
  const frequency = new Map<string, number>();
  for (const entry of entries) for (const term of entry.terms.keys()) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  return { entries, frequency, average: entries.reduce((sum, e) => sum + e.length, 0) / Math.max(1, entries.length) };
}

/**
 * The part of a section about the query: its block (a paragraph, a list item or a whole table) with the most of the
 * query's different words, the earliest on a tie, then the blocks after it while they fit.
 */
function excerpt(body: string, query: Set<string>) {
  const blocks = body.replace(/\*\*/g, '').split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+\.)\s)/).map(b => b.trim()).filter(Boolean);
  if (!blocks.length) return '';
  const covered = blocks.map(b => new Set(words(b).filter(w => query.has(w))).size), best = covered.indexOf(Math.max(...covered));
  let text = blocks[best]!;
  for (let i = best + 1; i < blocks.length && text.length + blocks[i]!.length < EXCERPT; i++) text += `\n${blocks[i]}`;
  text = text.replace(/[ \t]+/g, ' ');
  return `${best > 0 ? '… ' : ''}${text.length > EXCERPT ? `${text.slice(0, EXCERPT).replace(/\s+\S*$/, '')} …` : text}`;
}

/** The sections of the published docs that best match a query, each a short excerpt with its page, section and link. */
export function searchDocs(query: string) {
  index ??= build();
  const asked = [...new Set(words(query.slice(0, 200)))].slice(0, 12), n = index.entries.length;
  const scored = index.entries.map(entry => {
    let score = 0;
    for (const term of asked) {
      const tf = entry.terms.get(term) ?? 0;
      if (!tf) continue;
      const df = index!.frequency.get(term) ?? 0, idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * entry.length / index!.average));
    }
    return { entry, score };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, RESULTS);
  const results = scored.map(({ entry }) => ({ page: entry.page, section: entry.section,
    url: `${repositoryUrl}/blob/production/${entry.path}${entry.anchor ? `#${entry.anchor}` : ''}`, text: excerpt(entry.body, new Set(asked)) }));
  return results.length ? { query, results }
    : { query, results, note: 'Nothing in the published docs matches. Try other words once; otherwise say you don’t know, point to https://nightmail.dev/docs and offer a ticket.' };
}
