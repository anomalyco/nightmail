// Customer-safe projection (design §4.1): every support-route response passes through here before the model sees it.
// The model's context is, in effect, shown to the customer, so it gets only what the customer may see: no grant or
// operator internals, third-party text fenced as untrusted, no angle bracket in any string or key, and a bounded size.

/**
 * What the fence escapes: angle brackets, the look-alikes Unicode normalization (NFKC, NFKD, NFD) turns into one (＜ ﹤ ≮
 * and their pairs), and `&`, so that unfenced can undo it exactly.
 */
const ESCAPE = /[&<>\u226E\u226F\uFE64\uFE65\uFF1C\uFF1E]/g;
const NAMED: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
/**
 * Outside text placed inside the harness's tags, escaped (`&amp;`, `&lt;`, `&gt;`; a look-alike as its numeric reference),
 * so no input, however it is written, can close a fence or open a tag. Never strip instead: removing a marker in one pass
 * leaves `</untr</untrusted>usted>` a marker. Escape each text once: unfenced reverses exactly one escape.
 */
export const fenced = (text: string) => text.replace(ESCAPE, c => NAMED[c] ?? `&#x${c.charCodeAt(0).toString(16).toUpperCase()};`);
const ESCAPED = /&(?:amp|lt|gt|#x(?:226E|226F|FE64|FE65|FF1C|FF1E));/g;
/**
 * What the agent writes, as it leaves it (an answer, a reply, a ticket, a note, any tool argument): fenced's escapes undone
 * once and nothing more, so quoted outside text reads as it was written. `unfenced(fenced(s))` is `s` for every string:
 * `&amp;lt;` becomes `&lt;`, and any other entity stays as written.
 */
export const unfenced = (text: string) => text.replace(ESCAPED, e => e === '&amp;' ? '&' : e === '&lt;' ? '<' : e === '&gt;' ? '>' : String.fromCharCode(parseInt(e.slice(3, -1), 16)));
/** Outside text as the model reads it: fenced, inside <untrusted> (naming where it came from, when the harness knows). */
export const untrusted = (text: string, source?: 'chat' | 'email') => `<untrusted${source ? ` source="${source}"` : ''}>${fenced(text)}</untrusted>`;

/** Fields support routes return that are about Nightmail's side of the conversation, never the customer's data. */
const DROP = new Set(['grant', 'operatorId', 'operator', 'ticketRef', 'token', 'tokenHash', 'internal', 'ipNetwork', 'userAgent', 'actorLabel', 'retainUntil', 'watch', 'watchFlag', 'handoffId', 'via']);
/**
 * Text written by other people (recipients, mail servers, the customer's own content such as a route's pattern and note,
 * the docs search_docs quotes): data, never instructions.
 */
const UNTRUSTED = new Set(['subject', 'diagnostic', 'diagnosticCode', 'text', 'html', 'snippet', 'lastError', 'pauseReason', 'reason', 'message', 'name', 'previewText', 'replyText', 'body',
  'note', 'match', 'page', 'section']);
/**
 * Internal IDs the model never needs (a conversation names its person itself), removed from every tool result and the
 * prefetched summary: people's, actors' and support's. Workspace, domain, campaign, email, delivery, webhook, request and
 * target IDs stay: the tools take them.
 * - these keys, anywhere;
 * - every identifier inside a user, actor (of any type), subject or member object;
 * - an audit summary's references to a support conversation, ticket, handoff, grant or member;
 * - any value shaped like a support conversation ID, a user ID (a UUID), an agent token, API key, inbox key or app
 *   password ID, an MCP grant, or a support grant, handoff or note, whatever field holds it.
 */
const PERSON_KEYS = new Set(['userId', 'user_id', 'actorId', 'actor_id', 'memberId', 'member_id', 'member', 'ticketRef', 'ticket_ref', 'grantId', 'grant_id', 'handoffId', 'handoff_id', 'conversationId', 'conversation_id']);
const PERSON_OBJECTS = new Set(['user', 'actor', 'subject', 'member']);
const SUMMARY_KEYS = new Set(['ticket', 'member', 'handoff', 'grant', 'conversation']);
const INTERNAL = [/^conv_[a-z2-7]{26}$/, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, /^(?:agt|key|mbk|apw|sgr|sho|snt)_[0-9a-f]{32}$/, /^mcp_[A-Za-z0-9_-]{1,200}$/];
/** The same shapes inside free text (a note written earlier), wherever they stand in it. */
const EMBEDDED = new RegExp(INTERNAL.map(shape => `(?<![A-Za-z0-9_-])(?:${shape.source.slice(1, -1)})(?![A-Za-z0-9_-])`).join('|'), 'gi');
const idLike = (key: string) => key === 'id' || /(?:Id|_id)$/.test(key);
const HIDDEN = Symbol('hidden');
export const RESULT_LIMIT = 8192;

/** `hidden`: values removed wherever they appear (the conversation's own person and ID), whatever field holds them. */
export function project(value: unknown, depth = 0, key = '', hidden: readonly string[] = []): unknown {
  if (depth > 8) return '[…]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map(v => project(v, depth + 1, key, hidden)).filter(v => v !== HIDDEN);
    return value.length > 50 ? [...items, `[${value.length - 50} more not shown]`] : items;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP.has(k) || PERSON_KEYS.has(k) || (PERSON_OBJECTS.has(key) && idLike(k)) || (key === 'summary' && SUMMARY_KEYS.has(k))) continue;
      const projected = project(v, depth + 1, k, hidden);
      if (projected !== HIDDEN) out[fenced(k)] = projected;
    }
    return out;
  }
  if (typeof value === 'string' && (hidden.includes(value) || INTERNAL.some(shape => shape.test(value)))) return HIDDEN;
  if (typeof value === 'string') {
    const capped = value.length > 2000 ? `${value.slice(0, 2000)}… [${value.length - 2000} more characters]` : value;
    // Every non-empty value of these keys, whatever its script: a rule on letters would let look-alikes or zero-width
    // characters through unmarked.
    return UNTRUSTED.has(key) && capped.length > 0 ? untrusted(capped) : fenced(capped);
  }
  return value;
}

/** Free text with every internal ID and `hidden` value inside it replaced by "[hidden]". */
export function scrubIds(text: string, hidden: readonly string[] = []): string {
  let out = text.replace(EMBEDDED, '[hidden]');
  for (const value of hidden) if (value.length >= 4) out = out.replaceAll(value, '[hidden]');
  return out;
}

/** The tool result as the model reads it: projected JSON, at most RESULT_LIMIT bytes, without the `hidden` values. */
export function toolResult(value: unknown, hidden: readonly string[] = []): string {
  const projected = project(value, 0, '', hidden), text = JSON.stringify(projected === HIDDEN ? null : projected);
  if (text.length <= RESULT_LIMIT) return text;
  return `${text.slice(0, RESULT_LIMIT - 120)}… [truncated: ask for a narrower window, one workspace or the next page]`;
}
