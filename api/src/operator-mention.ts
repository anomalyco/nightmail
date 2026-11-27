import { sql, type SQL } from 'drizzle-orm';
import { log, type Runtime } from './core.js';
import { SlackRefused } from './reputation-alerts.js';
import { WRITE_LIMITS } from './health-counters.js';

// Urgent operator cards mention the operator by name, so Slack notifies their phone. Who: OPERATOR_SLACK_MENTION, a
// Slack user ID in the repository's production configuration (wrangler.prod.jsonc); unset (dev, tests, self-hosted),
// no card mentions anyone and every card posts exactly as without this.
//
// Which cards, keyed by card kind (MENTIONS). A card of another kind never mentions. 'capped' kinds share a ceiling of
// MENTION_LIMITS.perHour mentions in any rolling hour; a capped card over it still posts, unmentioned, and the next
// mentioned card says how many were not. 'own' kinds are outside the ceiling (a burst of pauses must not silence them).
// Every kind mentions at most once per subject (a workspace, a cluster, a domain, a region) in any rolling hour.
//
// The decision is made once per card (operator_mentions, keyed by the card's own ID: its job, its alert, its Health
// episode), so every retry of a card posts it the same way. A mention can never cost a card: if Slack refuses the
// mentioned message (a 4xx other than 429), the same card is posted at once without it, and the mention is dropped.
// The decision runs under the standard limits (WRITE_LIMITS: a second for a lock, three for a statement), so a held lock
// or anything else going wrong with it posts the card unmentioned at once, never late: it is then recorded as not
// mentioned where that is possible, so a retry posts it the same way and the next mention counts it.

/** Card kinds that mention the operator: 'capped' share the hourly ceiling, 'own' have only the one-per-subject bound. */
export const MENTIONS: Record<string, 'capped' | 'own'> = {
  paused: 'capped', // A workspace paused, by the ladder, the content screen or an operator (operator-alerts.ts).
  amazon_paused: 'capped', // AWS paused a workspace's SES tenant (operator-alerts.ts).
  abuse_high: 'capped', // A high abuse-monitoring alert: new, risen to high, or a new member at high (abuse-alerts.ts).
  link_domain_held: 'capped', // A link domain held after a confirmed blocklist listing: Health's opening card only (health.ts).
  amazon_account: 'own', // Amazon's account status for a region became unhealthy or worse (operator-alerts.ts).
};
export const MENTION_LIMITS = { perHour: 6 } as const;
export type Mention = { user: string; skipped: number };

/**
 * Whether this card mentions the operator, decided once for the card (a retry gets the same answer): null for no.
 * card is the card's stable ID; subject what it is about. Never throws, and never takes longer than WRITE_LIMITS allow.
 */
export async function mentionFor(runtime: Pick<Runtime, 'db' | 'config'>, card: { id: string | SQL; kind: string; subject: string }): Promise<Mention | null> {
  const user = runtime.config.operatorSlackMention, rule = Object.hasOwn(MENTIONS, card.kind) ? MENTIONS[card.kind] : undefined;
  if (!user || !rule) return null;
  const capped = rule === 'capped', id = typeof card.id === 'string' ? sql`${card.id}::text` : card.id;
  try {
    const row = await runtime.db.transaction(async tx => {
      await tx.execute(WRITE_LIMITS);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('operator.mention',0))`);
      return (await tx.execute<{ mentioned: boolean; skipped: number }>(sql`WITH card AS (SELECT ${id} AS id),
          prior AS (SELECT m.mentioned,m.skipped FROM operator_mentions m JOIN card ON m.card=card.id),
          recent AS (SELECT * FROM operator_mentions WHERE mentioned AND at>now()-interval '1 hour'),
          seen AS (SELECT card.id,NOT EXISTS (SELECT FROM recent WHERE kind=${card.kind} AND subject=${card.subject}) AS fresh,
            (SELECT count(*) FROM recent WHERE capped) AS used FROM card WHERE NOT EXISTS (SELECT FROM prior)),
          choice AS (SELECT id,fresh AND (NOT ${capped} OR used<${MENTION_LIMITS.perHour}) AS mentioned,${capped} AND fresh AND used>=${MENTION_LIMITS.perHour} AS over FROM seen),
          told AS (UPDATE operator_mentions m SET told_by=c.id FROM choice c WHERE c.mentioned AND m.over AND m.told_by IS NULL RETURNING m.card),
          aged AS (DELETE FROM operator_mentions WHERE at<now()-interval '2 days'),
          added AS (INSERT INTO operator_mentions(card,kind,subject,capped,mentioned,over,skipped)
            SELECT id,${card.kind},${card.subject},${capped},mentioned,over,(SELECT count(*)::int FROM told) FROM choice RETURNING mentioned,skipped)
        SELECT mentioned,skipped FROM added UNION ALL SELECT mentioned,skipped FROM prior`)).rows[0];
    });
    return row?.mentioned ? { user, skipped: Number(row.skipped) } : null;
  } catch {
    log('warn', { code: 'OPERATOR_MENTION_FAILED', kind: card.kind });
    // Not mentioned: kept so (a retry of this card is unmentioned too) and, if capped, told by the next mention. Best effort,
    // under the same limits and without the lock.
    await runtime.db.transaction(async tx => {
      await tx.execute(WRITE_LIMITS);
      await tx.execute(sql`INSERT INTO operator_mentions(card,kind,subject,capped,mentioned,over) VALUES ((${id}),${card.kind},${card.subject},${capped},false,${capped}) ON CONFLICT (card) DO NOTHING`);
    }).catch(() => {});
    return null;
  }
}

/** The card went out without its mention (Slack refused it with one): the mention is not counted, and what it would have told is told by the next. */
async function dropMention(runtime: Pick<Runtime, 'db'>, card: string | SQL) {
  const id = typeof card === 'string' ? sql`${card}::text` : card;
  try {
    await runtime.db.execute(sql`WITH dropped AS (UPDATE operator_mentions SET mentioned=false,skipped=0 WHERE card=(${id}) AND mentioned RETURNING card)
      UPDATE operator_mentions m SET told_by=NULL FROM dropped d WHERE m.told_by=d.card`);
  } catch { log('warn', { code: 'OPERATOR_MENTION_FAILED', step: 'drop' }); }
}

const LOOKALIKE: Record<string, string> = { '*': '\u2217', '_': '\u02cd', '~': '\u223c', '`': '\u02cb' };
/** Plain text as mrkdwn that reads the same: no markup, no mention or link of its own. */
const asMrkdwn = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[*_~`]/g, c => LOOKALIKE[c]!);
export const skippedWords = (n: number) => `${n.toLocaleString('en-US')} urgent ${n === 1 ? 'card' : 'cards'} before this one went out without a mention (more than ${MENTION_LIMITS.perHour} an hour).`;
type Message = Record<string, unknown> & { text: string; blocks?: { type: string; text?: { type: string; text: string } }[] };
/**
 * The card with the mention: before its words in the notification text and in its first section (turned into mrkdwn
 * if it was plain text), and, when cards over the ceiling went unmentioned before it, how many, after them.
 */
export function withMention<T extends Message>(message: T, mention: Mention): T {
  const lead = `<@${mention.user}>`, note = mention.skipped > 0 ? skippedWords(mention.skipped) : '';
  const after = (words: string) => note ? `${words}${words.includes('\n') ? '\n' : /[.!?]$/.test(words) ? ' ' : '. '}${note}` : words;
  const [first, ...rest] = message.blocks ?? [];
  const section = first?.type === 'section' && first.text
    ? { ...first, text: first.text.type === 'mrkdwn' ? { ...first.text, text: after(`${lead} ${first.text.text}`) } : { type: 'mrkdwn', text: after(`${lead} ${asMrkdwn(first.text.text)}`), verbatim: true } }
    : first;
  return { ...message, text: after(`${lead} ${message.text}`), ...(message.blocks ? { blocks: [section, ...rest] } : {}) };
}

/**
 * Posts a card through send, mentioned when mention says so. If Slack refuses the mentioned card (a 4xx other than
 * 429: Slack took nothing), it is posted again at once without the mention, and the mention is dropped; that post's
 * outcome is the card's. Anything else (a 429, a 5xx, no answer) is the card's own outcome, as without a mention.
 * mentionable: the card to mention, when it reads differently in mrkdwn (Health's held link domain); message is posted
 * without the mention.
 */
export async function sendMentioned(runtime: Pick<Runtime, 'db'>, send: (message: Message) => Promise<void>, message: Message, mention: Mention | null, card: string | SQL, mentionable: Message = message) {
  if (!mention) return send(message);
  try { return await send(withMention(mentionable, mention)); }
  catch (error) {
    if (!(error instanceof SlackRefused) || error.status === 429 || error.status < 400 || error.status >= 500) throw error;
    log('warn', { code: 'OPERATOR_MENTION_REFUSED', status: error.status });
    await send(message);
    await dropMention(runtime, card);
  }
}
