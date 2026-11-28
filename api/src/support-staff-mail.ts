import { createHash } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { errors, notFound } from './core/errors.js';
import { json, response } from './core/http.js';
import { log } from './log.js';
import type { App, Config, Database, DbExecutor } from './core/types.js';
import { productName } from './brand.js';
import { htmlToPlain, replyText } from './mailbox-store.js';
import { safeMailText } from './inbox-content.js';
import { renderNotice, type Line, type Notice } from './notices.js';
import { approvalLink, heldWhy, isKind, KINDS, propose } from './support-approvals.js';
import { emailEvidence, supportPlatformOnly } from './support-conversations.js';
import { event, itemColumns, itemFrom, triageCandidates, TRIAGE_REASONS, type Brief, type ItemRow } from './support-inbox.js';
import type { StaffReply, StaffReplyIgnored } from './support-contract.js';
export type { StaffReply, StaffReplyIgnored };

// One path to a human. Whatever needs a person in support has a ticket and one email thread to staff: every conversation
// in Needs you (src/support-inbox.ts: an open ticket, held or failed answers, blocked work, a customer waiting on a paused
// agent, no reply sent; agent feedback, whose reports are tickets), and every email to a support address that never
// became a conversation and that nobody answered. A conversation without a ticket is given one here (type staff; the
// agent's own ticket, mirrored later, takes its place).
//
// The support platform asks for the emails on its sweep (POST /v1/operator/support/staff-mail, the binding only), sends
// each from the support address to the team address it keeps (TICKET_TO), and reports it sent: the first one in a thread
// starts it, later ones reply in it under the same subject. Each email is written here once and frozen, so a retried send
// is the same email under the same key. A thread's first email goes at once (one workspace's agent feedback waits five
// minutes, so a burst of reports is one email); after that it hears of something new (they wrote again, an answer was
// held, a new reason) at most every 30 minutes, and all of support sends staff at most 20 emails an hour.
//
// Each email is short and readable on a phone, in this order: who and which workspace; what they asked, in their own
// words (quoted as untrusted text: escaped, links shown with their real host and never made clickable); what the agent
// checked and found (for agent feedback, the triage agent's summary, src/feedback-triage.ts, when its note is written
// before the email); the one decision, with the agent's recommendation; one link to the conversation. Where the
// decision is a yes or no on something proposed (src/support-approvals.ts), the button opens the conversation with it
// ready to confirm, and only a signed-in operator's confirm runs it. The footer names the ticket, and that replying adds
// a note.
//
// A reply to a staff email becomes an internal note on its conversation (staffReply below), and nothing else: the support
// platform asks before it treats any email to a support address as a customer's (POST
// /v1/operator/support/staff-mail/replies). It is a reply to a staff email when ingest filed it in a staff email's thread,
// the thread its own In-Reply-To and References lead to, never because of anything in its subject or words. It becomes a
// note only from a verified staff sender: the proof a customer's email needs to count as verified (its one literal From,
// DMARC pass vouched for at the support address, not sent through Nightmail itself), from the team address (TICKET_TO,
// which the support platform passes) or an operator's verified account email. Any other reply to a staff email is
// ignored: never a conversation, never answered.
//
// A staff email the support platform can't send is reported each time it fails (POST …/{key}/failed); after three tries
// it failed for good: never offered again, so it can't hold up the rest of staff mail or its own thread. It counts as not
// sent on Glass's support tile (src/glass.ts) until its thread gets an email that goes. The thread's next email comes with
// the next change, as if the failed one never was: its thread's first, when nothing in it was sent.

const UPDATE_EVERY = 30, FEEDBACK_WINDOW = 60, FEEDBACK_SETTLE = 5, FEEDBACK_WAIT = 30, UNROUTED_AFTER = 30, UNROUTED_DAYS = 30;
export const STAFF_MAIL_LIMITS = { perHour: 20, batch: 20, attempts: 3 } as const;
/** The longest note a reply to a staff email becomes, in characters: its own words, without the quoted email. */
export const STAFF_NOTE_MAX = 4000;
/** Notes by email a conversation takes an hour, at most. */
export const STAFF_NOTES_PER_HOUR = 20;

type Words = { text: string; at: string };
export type StaffRow = ItemRow & {
  brief: Brief | null; evidence: { filedBy?: string } | null; staff_thread: string | null; staff_seq: number; staff_reasons: string[]; role: string | null;
  max_seq: number; held_reason: string | null; held_seq: number | null; held_id: string | null; first_words: Words | null; fresh_words: Words[] | null;
  operation: string | null; request_id: string | null; filed_at: string | null; failed_by: 'agent' | 'staff' | null;
  /** Agent feedback: the triage agent's summary of the report, once its note is written. */
  triage_summary: string | null;
  /** The agent's newest risky proposal waiting for staff (support-approvals.ts), if any. */
  proposal?: { id: string; kind: string; payload: Record<string, unknown>; reason: string; expires_ms: number } | null;
};
type Need = 'failed' | 'held' | 'no_reply' | 'proposal' | 'blocked' | 'waiting' | 'ticket' | 'feedback';
/** emails: every email the thread has (numbering the next); sent: those that went; pending: one still to go (not failed for good). */
type Thread = { key: string; subject: string; opened_at: string; last_sent_at: string | null; emails: number; sent: number; pending: boolean };

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ticketId = () => `tkt_${Array.from(crypto.getRandomValues(new Uint8Array(16)), b => BASE32[b & 31]).join('')}`;
const emailKey = (thread: string, seq: number) => `staff-${createHash('sha256').update(thread).digest('hex').slice(0, 24)}-${seq}`;
/** Words someone else chose (a name, a title, a subject) on one line, without control characters, at most `max` long. */
const oneLine = (value: string | null | undefined, max = 80) => {
  const text = (value ?? '').normalize('NFC').replace(/[\p{C}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
/** Such words in an email's body, kept from turning into something to tap: a zero-width space after every dot between
 *  letters and after a scheme's colon (as notices.ts quotes them), so a name like "pay-now.example" is never a link. */
const inert = (value: string) => value.replace(/([\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, '$1.\u200b').replace(/:\/\//g, ':\u200b//');
const moment = (iso: string) => { const d = new Date(iso); return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} at ${d.toISOString().slice(11, 16)} UTC`; };
const ago = (iso: string, now: number) => {
  const minutes = Math.max(1, Math.round((now - Date.parse(iso)) / 60_000));
  return minutes < 90 ? `${minutes} minute${minutes === 1 ? '' : 's'}` : minutes < 36 * 60 ? `${Math.round(minutes / 60)} hours` : `${Math.round(minutes / 1440)} days`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Gives a conversation a ticket of type staff (it needs a person), with its timeline line: when it has none, or, with
 * `reopen`, when its ticket was resolved. `details` go on that line (reason chat_unavailable: a message the support chat
 * couldn't take, src/support-conversations.ts fileChatTicket). Answers the new ticket's ID, or null when it kept the one it had.
 */
export async function openStaffTicket(tx: DbExecutor, conversationId: string, severity: 'P2' | 'P3', reopen = false, details: Record<string, unknown> = {}) {
  const id = ticketId();
  const { rows: [opened] } = await tx.execute<{ id: string }>(sql`UPDATE support_conversations SET ticket_id = ${id}, ticket_type = 'staff', ticket_severity = ${severity}, ticket_at = now(), ticket_resolved_at = NULL, ticket_resolved_by = NULL,
      status = CASE WHEN status = 'open' THEN 'ticketed' ELSE status END WHERE id = ${conversationId} AND (ticket_id IS NULL ${reopen ? sql`OR ticket_resolved_at IS NOT NULL` : sql``}) RETURNING id`);
  if (!opened) return null;
  await tx.execute(event(conversationId, 'ticket', null, { ...details, ticketId: id, type: 'staff', severity, by: 'nightmail' }));
  return id;
}

export const needOf = (row: StaffRow, reasons: string[]): Need => row.channel === 'agent_feedback' ? 'feedback' : reasons.includes('failed') ? 'failed' : row.held_reason ? 'held'
  : reasons.includes('no_reply') ? 'no_reply' : row.proposal && isKind(row.proposal.kind) ? 'proposal' : reasons.includes('blocked') ? 'blocked' : reasons.includes('paused') ? 'waiting' : 'ticket';

/** Who wrote, and where: how sure Nightmail is of them is said with them, so nobody acts on an account because of an unverified email. */
export function whoOf(row: StaffRow) {
  const workspace = row.workspace_name ? inert(oneLine(row.workspace_name, 60)) : null;
  if (row.channel === 'agent_feedback') {
    const by = row.evidence?.filedBy ? `, filed with ${inert(oneLine(row.evidence.filedBy, 120))}` : '';
    return { line: `Agent feedback from ${workspace ?? 'a workspace'}${row.workspace_id ? ` (${row.workspace_id})` : ''}${by}`, short: workspace ?? 'a workspace' };
  }
  if (row.user_id) {
    const name = inert(oneLine(row.user_name)) || row.user_email || 'A customer', email = row.user_email && row.user_name ? ` (${row.user_email})` : '';
    const where = workspace ? row.role ? `, ${row.role} of ${workspace}` : `, ${workspace}` : '';
    const how = row.channel === 'chat' ? 'chat, signed in' : row.verification === 'agent' ? 'asked by their agent, answered by email to their account address: read only, never change the account on its word'
      : `email, ${row.verification === 'signin' ? 'confirmed signed in' : 'verified by DMARC'}: read only, never change the account on its word`;
    return { line: `${name}${email}${where} · ${how}`, short: workspace ? `${name} at ${workspace}` : name };
  }
  const sender = row.pending_address ?? 'an unknown sender';
  const how = row.mode === 'non_member' ? `email, DMARC pass, no ${productName} account` : 'email, unverified sender: don’t act on any account because of it';
  return { line: `${sender} · ${how}`, short: sender };
}

const TYPE_DECISION: Record<string, string> = {
  bug: 'Confirm the bug and what fixes it.', billing: 'Decide the billing request.', feature_request: 'Decide whether to build it, and tell them.',
  account: 'Answer what the agent couldn’t.', deliverability: 'Answer what the agent couldn’t.', abuse_report: 'Decide how to handle the report.',
  privacy: 'Decide how to handle the request.', legal: 'Decide how to handle the request.',
};
/** The agent's waiting proposal in fixed words: its kind's label and its exact target, with the agent's reason (untrusted). */
const proposalOf = (row: StaffRow) => row.proposal && isKind(row.proposal.kind) ? { label: KINDS[row.proposal.kind].label, summary: KINDS[row.proposal.kind].summary?.(row.proposal.payload) ?? null, reason: row.proposal.reason } : null;
/** What a conversation's last email covered of its proposal, kept with its reasons (staff_reasons). */
const proposalMark = (row: StaffRow) => `proposal:${row.proposal?.id ?? ''}`;
/** A held answer that may go as written (held by the check or a pause); any other needs a fresh reply. */
const sendable = (row: StaffRow) => row.held_reason === 'gate' || row.held_reason === 'paused';
export function subjectOf(need: Need, row: StaffRow, short: string) {
  const title = oneLine(row.brief?.title ?? row.subject ?? row.first_words?.text.split('\n').find(Boolean), 70);
  switch (need) {
    case 'failed': return `A reply to ${short} failed to send`;
    case 'held': return `Review a held answer to ${short}`;
    case 'no_reply': return `${short} got no reply`;
    case 'proposal': return `Approve a change for ${short}: ${proposalOf(row)?.label ?? 'a proposal'}`;
    case 'blocked': return `Support work for ${short} is stuck`;
    case 'waiting': return `${short} is waiting for you`;
    case 'feedback': return `Agent feedback from ${short}${title ? `: ${title}` : ''}`;
    case 'ticket': {
      const what = { bug: 'Bug report', billing: 'Billing decision', feature_request: 'Feature request', abuse_report: 'Abuse report', privacy: 'Privacy request', legal: 'Legal request' }[row.ticket_type ?? ''];
      return what ? `${what} from ${short}${title ? `: ${title}` : ''}` : `${short} needs an answer${title ? `: ${title}` : ''}`;
    }
  }
}

/** Someone's words, short: at most three lines and about 240 characters, the rest left to the conversation. */
const shortQuote = (value: string) => {
  const lines = value.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).filter((line, i, all) => line || (i > 0 && all[i - 1])).join('\n').trim().split('\n');
  const kept = lines.slice(0, 3).join('\n'), cut = kept.length > 240 ? cutAt(kept, 240) : kept;
  return cut.length < value.trim().length ? `${cut.trimEnd()}${/[.!?:]$/.test(cut.trimEnd()) ? ' …' : '…'}` : cut;
};
/** Untrusted words cut to `n` characters at a space, and never inside a link, whose real host a cut could change (cut
 *  short, "https://nightmail.dev.evil.example/…" would read as linking to nightmail.dev): with no space, a link the cut
 *  reaches is left out. */
const cutAt = (text: string, n: number) => { const cut = text.slice(0, n); return /\s/.test(cut) ? cut.replace(/\s+\S*$/, '') : cut.replace(/(?:https?:\/\/|www\.)\S*$/i, ''); };
/** Words on one line, at most `max` long, cut as cutAt cuts. */
const clip = (value: string, max: number) => {
  const text = oneLine(value, Number.MAX_SAFE_INTEGER);
  return text.length > max ? `${cutAt(text, max - 1).trimEnd()}…` : text;
};
/** What an agent wrote, on one line: its whole sentences that fit in about 220 characters (at least the first). */
const sentences = (value: string) => {
  const text = value.replace(/\s+/g, ' ').trim(), parts = text.match(/.+?[.!?]+(?=\s|$)|.+$/g) ?? [text];
  let kept = '';
  for (const part of parts) { if (kept && (kept + part).length > 220) break; kept += part; }
  return clip(kept.trim(), 220);
};

/** One sentence: what the agent found (its summary, its own words and so untrusted), or, without one, why this needs a person now. */
function foundOf(need: Need, row: StaffRow, now: number): Line | null {
  if (row.brief?.summary) return { untrusted: sentences(row.brief.summary) };
  switch (need) {
    case 'failed': return row.failed_by === 'staff' ? 'A staff reply to them failed to send.' : 'The agent’s answer to them failed to send.';
    case 'no_reply': return row.since ? `Nothing has reached them for ${ago(row.since, now)}.` : null;
    case 'blocked': return `The support platform couldn’t finish ${plural(row.blocked_work, 'piece')} of work.`;
    case 'waiting': return row.paused_by === 'ticket' ? 'The agent stopped at its ticket, and they’re waiting.' : `${inert(oneLine(row.paused_by_name)) || 'Staff'} paused the agent, and they’re waiting.`;
    default: return null;
  }
}
/** The one decision (set in bold) and the recommendation: one plain line, the agent's own words kept untrusted. */
function decisionOf(need: Need, row: StaffRow): { decision: string; recommendation: Line | null } {
  const recommended = row.brief?.recommendation ? { untrusted: `It recommends: ${clip(row.brief.recommendation, 220)}` } : null;
  switch (need) {
    case 'failed': return { decision: 'Send the reply again, or write a new one.', recommendation: null };
    case 'held': return sendable(row)
      ? { decision: 'Send the agent’s held answer, or write your own.', recommendation: recommended ?? (row.held_reason === 'gate' ? 'The output check held it: read it before sending.' : null) }
      : { decision: 'Write them a fresh reply.', recommendation: `The agent’s held answer can’t go as written. ${heldWhy(row.held_reason)}.` };
    case 'no_reply': return { decision: 'Reply to them now.', recommendation: recommended };
    case 'proposal': { const p = proposalOf(row);
      return { decision: `Approve or decline: ${p?.label ?? 'the agent’s proposal'}${p?.summary ? ` (${p.summary})` : ''}.`, recommendation: p ? { untrusted: `The agent’s reason: ${oneLine(p.reason, 220)}` } : null }; }
    case 'blocked': return { decision: 'Retry the stuck work, or look at why it’s stuck.', recommendation: null };
    case 'waiting': return { decision: 'Reply to them, or hand the conversation back to the agent.', recommendation: recommended };
    case 'ticket': return { decision: TYPE_DECISION[row.ticket_type ?? ''] ?? 'Answer them.', recommendation: recommended };
    case 'feedback': return { decision: 'A bug to fix, a gap in the docs, or neither?', recommendation: row.request_id ? 'Start with its request ID in the logs.' : null };
  }
}

/** What's new for a conversation since its last email, as one sentence. */
function changesOf(row: StaffRow, reasons: string[], now: number) {
  const parts: string[] = [];
  if (row.fresh_words?.length) parts.push(row.fresh_words.length === 1 ? 'they wrote again' : `they wrote ${row.fresh_words.length} more times`);
  if ((row.held_seq ?? 0) > row.staff_seq) parts.push('an answer was held');
  for (const reason of reasons.filter(r => !row.staff_reasons.includes(r))) {
    if (reason === 'no_reply' && row.since) parts.push(`no reply has reached them for ${ago(row.since, now)}`);
    if (reason === 'failed') parts.push('a reply failed to send');
    if (reason === 'blocked') parts.push('support work got stuck');
    if (reason === 'paused') parts.push('the agent is paused and they’re waiting');
    if (reason === 'ticket' && row.ticket_type !== 'staff') parts.push('the agent filed a ticket');
  }
  if (row.proposal && !row.staff_reasons.includes(proposalMark(row))) parts.push('the agent proposed a change for you to approve');
  return parts.length ? `Since the last email, ${parts.join(', ')}.` : 'It still needs you.';
}
/** The footer: the ticket (or tickets), and, for a conversation's thread, that replying adds a note to it (staffReply). */
const ticketLine = (ids: (string | null)[], replies = false) => {
  const shown = ids.filter((id): id is string => !!id), tickets = shown.length ? `${shown.length === 1 ? 'Ticket' : 'Tickets'} ${shown.slice(0, 3).join(', ')}${shown.length > 3 ? '…' : ''}` : 'No ticket';
  return replies ? `${tickets} · Reply to add a note.` : tickets;
};

/**
 * A conversation's email: who and where (with when they wrote), their words (three lines at most), one sentence of what
 * the agent found, the decision in bold with its recommendation, the button (or two), and the ticket. An update says
 * what changed instead of what was found.
 */
export function conversationEmail(origin: string, row: StaffRow, reasons: string[], first: boolean, now: number, approval: { url: string; label: string } | null, subject: string): Notice {
  const need = needOf(row, reasons), who = whoOf(row), words = first ? row.first_words ? [row.first_words] : [] : row.fresh_words?.slice(-1) ?? [];
  const lines: Line[] = [{ text: words.length ? `${who.line} · ${moment(words[0]!.at)}` : who.line, tone: 'muted' }];
  if (words.length) lines.push({ quote: shortQuote(words[0]!.text) });
  const found = first ? foundOf(need, row, now) : changesOf(row, reasons, now);
  if (found) lines.push(found);
  const { decision, recommendation } = decisionOf(need, row);
  lines.push({ text: decision, tone: 'strong' });
  if (recommendation) lines.push(recommendation);
  const conversation = { label: 'Open the conversation', url: `${origin}/support/${row.id}` };
  return renderNotice({ subject, lines, action: approval ?? conversation, ...approval ? { secondary: conversation } : {}, why: ticketLine([row.ticket_id], true) }, origin);
}

/** One workspace's agent feedback: each report's facts and words, what the triage agent found in it (one line), the decision, and the tickets. */
export function feedbackEmail(origin: string, rows: StaffRow[], first: boolean, subject: string): Notice {
  const lead = rows[0]!, workspace = whoOf(lead).line.replace(/, filed with .*$/, ''), lines: Line[] = [];
  const facts = (row: StaffRow) => [row.evidence?.filedBy ? inert(oneLine(row.evidence.filedBy, 120)) : null, row.operation ? inert(oneLine(row.operation, 60)) : null, row.request_id ?? 'no request ID', moment(row.filed_at ?? row.created_at)].filter(Boolean).join(' · ');
  if (rows.length === 1) lines.push({ text: `${workspace} · ${facts(lead)}`, tone: 'muted' });
  else lines.push({ text: first ? workspace : `${workspace} · ${plural(rows.length, 'more report')}`, tone: 'muted' });
  for (const row of rows.slice(0, 5)) {
    if (rows.length > 1) lines.push({ text: facts(row).replace(/^./, c => c.toUpperCase()), tone: 'muted' });
    if (row.first_words) lines.push({ quote: shortQuote(row.first_words.text) });
    if (row.triage_summary) lines.push({ untrusted: sentences(row.triage_summary) });
  }
  if (rows.length > 5) lines.push(`And ${plural(rows.length - 5, 'more report')} in the support inbox.`);
  const { decision, recommendation } = decisionOf('feedback', lead);
  lines.push({ text: decision, tone: 'strong' });
  if (recommendation && rows.length === 1) lines.push(recommendation);
  const action = rows.length === 1 ? { label: 'Open the report', url: `${origin}/support/${lead.id}` } : { label: 'Open the reports', url: `${origin}/support?view=needs_you&channel=agent_feedback` };
  return renderNotice({ subject, lines, action, why: ticketLine(rows.map(r => r.ticket_id), true) }, origin);
}

export type Unrouted = { thread_id: string; id: string; subject: string | null; from_address: string; dmarc: string; text: string | null; html: string | null; received_at: string; address: string };
export function unroutedEmail(origin: string, m: Unrouted, ticket: string, subject: string): Notice {
  const words = safeMailText(m.text?.trim() ? m.text : null, m.html).text;
  const lines: Line[] = [{ text: `${m.from_address} · email to ${m.address} · ${m.dmarc === 'PASS' ? 'DMARC pass, no account checked' : 'unverified sender: don’t act on any account because of it'} · ${moment(m.received_at)}`, tone: 'muted' },
    { quote: shortQuote(words || '(no text)') }, 'The support agent never saw it, and nobody has replied.', { text: 'Reply to them from the support address.', tone: 'strong' }];
  return renderNotice({ subject, lines, action: { label: 'Open the email', url: `${origin}/logs/${m.id}` }, why: ticketLine([ticket]) }, origin);
}

/**
 * Writes the emails that are due, in one transaction under an advisory lock (one planner at a time): gives every
 * conversation that needs you a thread (and a ticket, when it has none), then writes each thread's first email or its
 * update, within the limits. Answers how many it wrote.
 */
export async function planStaffMail(db: Database, config: Pick<Config, 'publicUrl' | 'authSecret' | 'support'>, now = Date.now()) {
  const origin = new URL(config.publicUrl).origin;
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('support-staff-mail', 0))`);
    const { rows: [sent] } = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM support_staff_emails WHERE created_at > now() - interval '1 hour'`);
    let budget = STAFF_MAIL_LIMITS.perHour - sent!.n, written = 0;
    if (budget <= 0) return 0;
    const { rows } = await tx.execute<StaffRow>(sql`SELECT ${itemColumns}, c.ticket_brief AS brief, c.evidence, c.staff_thread, c.staff_seq, c.staff_reasons,
        (SELECT wm.role FROM workspace_members wm WHERE wm.workspace_id = c.workspace_id AND wm.user_id = c.user_id LIMIT 1) AS role,
        coalesce((SELECT max(m.seq) FROM support_messages m WHERE m.conversation_id = c.id), 0) AS max_seq, held.reason AS held_reason, held.seq AS held_seq, held.id AS held_id,
        (SELECT json_build_object('text', left(m.text, 4000), 'at', m.created_at) FROM support_messages m WHERE m.conversation_id = c.id AND m.author = 'customer' ORDER BY m.seq LIMIT 1) AS first_words,
        (SELECT json_agg(json_build_object('text', left(x.text, 4000), 'at', x.created_at) ORDER BY x.seq) FROM (SELECT m.seq, m.text, m.created_at FROM support_messages m
          WHERE m.conversation_id = c.id AND m.author = 'customer' AND m.seq > c.staff_seq ORDER BY m.seq DESC LIMIT 3) x) AS fresh_words,
        f.operation, f.request_id, f.created_at::text AS filed_at, f.triage->>'summary' AS triage_summary,
        (SELECT m.author FROM support_messages m WHERE m.conversation_id = c.id AND m.delivery = 'failed' ORDER BY m.seq DESC LIMIT 1) AS failed_by,
        (SELECT json_build_object('id', a.id, 'kind', a.kind, 'payload', a.payload, 'reason', a.reason, 'expires_ms', (extract(epoch FROM a.expires_at) * 1000)::float8) FROM support_approvals a
          WHERE a.conversation_id = c.id AND a.proposed_by = 'agent' AND a.state = 'proposed' AND a.expires_at > now() ORDER BY a.created_at DESC LIMIT 1) AS proposal
      FROM ${itemFrom('')}
      LEFT JOIN LATERAL (SELECT m.id, coalesce(m.held_reason, 'unknown') AS reason, m.seq FROM support_messages m WHERE m.conversation_id = c.id AND m.delivery = 'held' AND m.draft_outcome IS NULL
        AND m.seq > coalesce((SELECT max(s.seq) FROM support_messages s WHERE s.conversation_id = c.id AND s.author = 'staff' AND s.kind IS DISTINCT FROM 'note'), 0) ORDER BY m.seq DESC LIMIT 1) held ON true
      LEFT JOIN support_feedback f ON f.conversation_id = c.id
      WHERE ${triageCandidates} AND triage.needs_you ORDER BY triage.urgency, triage.since, c.id LIMIT 200`);
    const reasonsOf = (row: StaffRow) => TRIAGE_REASONS.filter(reason => row[`why_${reason}`]);
    const changed = (row: StaffRow) => !row.staff_thread || reasonsOf(row).some(r => !row.staff_reasons.includes(r)) || !!row.fresh_words?.length || (row.held_seq ?? 0) > row.staff_seq
      || (!!row.proposal && !row.staff_reasons.includes(proposalMark(row)));
    /** What this email covers, for the next one to compare: the Needs you reasons and the proposal it carried. */
    const covered = (row: StaffRow) => [...reasonsOf(row), ...row.proposal ? [proposalMark(row)] : []];

    // Every conversation that needs a person has a thread, and a ticket.
    for (const row of rows.filter(r => !r.staff_thread)) {
      let key = `conv:${row.id}`;
      if (row.channel === 'agent_feedback' && row.workspace_id) {
        const { rows: [open] } = await tx.execute<{ key: string }>(sql`SELECT key FROM support_staff_threads WHERE workspace_id = ${row.workspace_id} AND key LIKE 'feedback:%'
          AND opened_at > now() - make_interval(mins => ${FEEDBACK_WINDOW}) ORDER BY opened_at DESC LIMIT 1`);
        key = open?.key ?? `feedback:${row.workspace_id}:${row.id}`;
      }
      await tx.execute(sql`INSERT INTO support_staff_threads(key, subject, workspace_id) VALUES (${key}, '', ${row.channel === 'agent_feedback' ? row.workspace_id : null}) ON CONFLICT (key) DO NOTHING`);
      if (!row.ticket_id) {
        // Its ticket is one of the reasons it needs you from now on, and this email names it.
        const id = await openStaffTicket(tx, row.id, row.urgency <= 2 ? 'P2' : 'P3');
        if (id) { row.ticket_id = id; row.ticket_type = 'staff'; row.why_ticket = true; }
      }
      await tx.execute(sql`UPDATE support_conversations SET staff_thread = ${key} WHERE id = ${row.id}`);
      row.staff_thread = key;
    }

    const keys = [...new Set(rows.filter(changed).map(r => r.staff_thread!))];
    const { rows: threads } = keys.length ? await tx.execute<Thread>(sql`SELECT t.key, t.subject, t.opened_at::text AS opened_at, t.last_sent_at::text AS last_sent_at,
        (SELECT count(*)::int FROM support_staff_emails e WHERE e.thread_key = t.key) AS emails, (SELECT count(*)::int FROM support_staff_emails e WHERE e.thread_key = t.key AND e.sent_at IS NOT NULL) AS sent,
        EXISTS (SELECT FROM support_staff_emails e WHERE e.thread_key = t.key AND e.sent_at IS NULL AND e.failed_at IS NULL) AS pending
      FROM support_staff_threads t WHERE t.key = ANY(${sql.param(keys)}::text[])`) : { rows: [] as Thread[] };
    const byKey = new Map(threads.map(t => [t.key, t]));
    for (const key of keys) {
      const thread = byKey.get(key);
      if (!thread || thread.pending || budget <= 0) continue;
      // A thread whose emails all failed for good starts again: its next email is a first one (thread.sent counts what went).
      const members = rows.filter(r => r.staff_thread === key), first = thread.sent === 0;
      const due = first ? members : members.filter(changed);
      if (!due.length) continue;
      if (first && key.startsWith('feedback:')) {
        const newest = Math.max(...members.map(r => Date.parse(r.filed_at ?? r.created_at)));
        if (newest > now - FEEDBACK_SETTLE * 60_000 && Date.parse(thread.opened_at) > now - FEEDBACK_WAIT * 60_000) continue;
      }
      if (!first && thread.last_sent_at && Date.parse(thread.last_sent_at) > now - UPDATE_EVERY * 60_000) continue;
      let mail: Notice;
      if (key.startsWith('feedback:')) {
        const subject = first ? due.length === 1 ? subjectOf('feedback', due[0]!, whoOf(due[0]!).short) : `${due.length} agent feedback reports from ${whoOf(due[0]!).short}` : thread.subject;
        mail = feedbackEmail(origin, due, first, subject);
      } else {
        const row = due[0]!, reasons = reasonsOf(row), need = needOf(row, reasons);
        // A yes or no on something proposed: the button opens the conversation with it ready to confirm. A held answer
        // is proposed only when it may go as written (held by the check or a pause); one that needs a fresh reply isn't.
        const kind = need === 'blocked' ? 'retry_work' : need === 'held' && row.held_id && (row.held_reason === 'gate' || row.held_reason === 'paused') ? 'send_held_answer' : null;
        // The agent's risky proposal is already proposed (support-actions.ts): the email carries its link.
        const proposed = need === 'proposal' && row.proposal ? { id: row.proposal.id, conversationId: row.id, expiresAt: new Date(Number(row.proposal.expires_ms)) } : null;
        const approval = proposed ?? (kind === 'retry_work' ? await propose(tx, { conversationId: row.id, kind, proposedBy: 'nightmail', reason: `The support platform couldn’t finish ${plural(row.blocked_work, 'piece')} of work.` })
          : kind === 'send_held_answer' ? await propose(tx, { conversationId: row.id, kind, proposedBy: 'nightmail', payload: { messageId: row.held_id }, reason: `${heldWhy(row.held_reason)}.` }) : null);
        const label = proposed ? proposalOf(row)!.label : kind ? KINDS[kind].label : null;
        mail = conversationEmail(origin, row, reasons, first, now, approval && label ? { label, url: approvalLink(config, approval) } : null, first ? subjectOf(need, row, whoOf(row).short) : thread.subject);
      }
      const seq = thread.emails + 1;
      await tx.execute(sql`INSERT INTO support_staff_emails(key, thread_key, seq, subject, text, html) VALUES (${emailKey(key, seq)}, ${key}, ${seq}, ${mail.subject}, ${mail.text}, ${mail.html})`);
      if (first) await tx.execute(sql`UPDATE support_staff_threads SET subject = ${mail.subject} WHERE key = ${key}`);
      for (const row of due) await tx.execute(sql`UPDATE support_conversations SET staff_seq = ${row.max_seq}, staff_reasons = ${sql.param(covered(row))}::text[] WHERE id = ${row.id}`);
      budget--; written++;
    }

    // Mail to a support address that never became a conversation, and nobody answered.
    const addressIds = config.support?.addressIds ?? [];
    if (addressIds.length && budget > 0) {
      const { rows: unrouted } = await tx.execute<Unrouted>(sql`SELECT * FROM (SELECT DISTINCT ON (m.thread_id) m.thread_id, m.id, m.subject, m.from_address, upper(coalesce(m.verdicts->>'dmarc', 'NONE')) AS dmarc,
          left(m.text, 4000) AS text, CASE WHEN m.text IS NULL THEN left(m.html, 200000) END AS html, m.received_at::text AS received_at, b.address
        FROM mailbox_messages mb JOIN mailboxes b ON b.id = mb.mailbox_id JOIN mail_messages m ON m.id = mb.message_id
        WHERE mb.mailbox_id = ANY(${sql.param(addressIds)}::text[]) AND mb.direction = 'inbound' AND m.thread_id IS NOT NULL AND NOT coalesce(m.automated, false) AND NOT coalesce(m.spam, false)
          AND m.received_at < now() - make_interval(mins => ${UNROUTED_AFTER}) AND m.received_at > now() - make_interval(days => ${UNROUTED_DAYS})
          AND NOT EXISTS (SELECT FROM support_messages s WHERE s.source_message_id = m.id)
          AND NOT EXISTS (SELECT FROM mail_messages o WHERE o.thread_id = m.thread_id AND o.direction = 'outbound')
          AND NOT EXISTS (SELECT FROM support_staff_threads t WHERE t.mail_thread_id = m.thread_id OR (t.sender = lower(m.from_address) AND t.opened_at > now() - interval '1 day'))
        ORDER BY m.thread_id, m.received_at) first ORDER BY received_at LIMIT ${budget}`);
      const senders = new Set<string>();
      for (const m of unrouted) {
        if (senders.has(m.from_address.toLowerCase())) continue;
        senders.add(m.from_address.toLowerCase());
        const key = `mail:${m.thread_id}`, ticket = ticketId(), subject = `Unanswered email to support${m.subject ? `: ${oneLine(m.subject, 70)}` : ''}`, mail = unroutedEmail(origin, m, ticket, subject);
        await tx.execute(sql`INSERT INTO support_staff_threads(key, subject, mail_thread_id, sender, ticket_id) VALUES (${key}, ${subject}, ${m.thread_id}, ${m.from_address.toLowerCase()}, ${ticket})`);
        await tx.execute(sql`INSERT INTO support_staff_emails(key, thread_key, seq, subject, text, html) VALUES (${emailKey(key, 1)}, ${key}, 1, ${mail.subject}, ${mail.text}, ${mail.html})`);
        budget--; written++;
      }
    }
    if (written) log('info', { code: 'SUPPORT_STAFF_MAIL_WRITTEN', emails: written });
    return written;
  });
}


// ---------- replies to staff emails ----------

/** A note's own ID, the same for one email in one conversation, so a retried reply is noted once. */
const noteId = (conversationId: string, messageId: string) => `msg_${Array.from(createHash('sha256').update(`staff-reply:${conversationId}:${messageId}`).digest().subarray(0, 16), b => BASE32[b & 31]).join('')}`;
/** A reply's own words as plain text: no quoted email, no control characters other than line breaks and tabs, bounded. */
export function staffNoteText(text: string | null, html: string | null) {
  const words = replyText(text ?? (html ? htmlToPlain(html) : '')).normalize('NFC')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return words.length > STAFF_NOTE_MAX ? `${words.slice(0, STAFF_NOTE_MAX - 1).trimEnd()}…` : words;
}

/**
 * An email to a support address that replies to a staff email: an internal note on each conversation of its staff thread
 * (one; a workspace's agent feedback, each of its reports), by its verified staff sender, once. `reply: false`: it is no
 * such reply (the support platform handles it as any support email). `ignored`: it is one, and nothing was noted.
 */
export async function staffReply(db: Database, config: Pick<Config, 'support'>, messageId: string, team: string | null): Promise<StaffReply> {
  const addressIds = config.support?.addressIds ?? [];
  if (!addressIds.length) return { reply: false };
  // The staff thread ingest filed it in (by its own In-Reply-To and References), at a support address. Nothing else names it.
  const { rows: [found] } = await db.execute<{ key: string; text: string | null; html: string | null; automated: boolean }>(sql`SELECT t.key, m.text, CASE WHEN m.text IS NULL THEN left(m.html, 200000) END AS html, coalesce(m.automated, false) AS automated
    FROM mail_messages m JOIN support_staff_threads t ON t.thread_id = m.thread_id
    WHERE m.id = ${messageId} AND m.direction = 'inbound' AND EXISTS (SELECT FROM mailbox_messages mm WHERE mm.message_id = m.id AND mm.workspace_id = m.workspace_id
      AND mm.direction = 'inbound' AND mm.mailbox_id = ANY(${sql.param(addressIds)}::text[]))
    LIMIT 1`);
  if (!found) return { reply: false };
  const ignored = (why: StaffReplyIgnored): StaffReply => { log('warn', { code: 'SUPPORT_STAFF_REPLY_IGNORED', reason: why }); return { reply: true, notes: 0, ignored: why }; };
  if (found.automated) return ignored('automated');
  // The sender: verified as a customer's email would be, and the team address or an operator's own.
  const evidence = await emailEvidence(db, addressIds, messageId);
  if (!evidence || evidence.verification !== 'dmarc' || evidence.evidence.selfSent) return ignored('unverified');
  const { rows: [operator] } = await db.execute<{ user_id: string }>(sql`SELECT p.user_id FROM platform_operators p JOIN nightmail_users u ON u.id = p.user_id
    WHERE p.role = 'operator' AND u.email_verified AND lower(u.email) = ${evidence.from} ORDER BY p.user_id LIMIT 1`);
  if (!operator && evidence.from !== team?.trim().toLowerCase()) return ignored('not_staff');
  const text = staffNoteText(found.text, found.html);
  if (!text) return ignored('empty');
  const { rows: conversations } = await db.execute<{ id: string }>(sql`SELECT id FROM support_conversations WHERE staff_thread = ${found.key} ORDER BY created_at, id LIMIT 20`);
  if (!conversations.length) return ignored('no_conversation');
  let notes = 0, limited = 0;
  for (const { id } of conversations) {
    const note = noteId(id, messageId);
    const made = await db.transaction(async (tx): Promise<0 | 1 | 'limited'> => {
      // The conversation's row lock numbers its messages; the note's own ID makes a retried reply a no-op.
      await tx.execute(sql`SELECT 1 FROM support_conversations WHERE id = ${id} FOR NO KEY UPDATE`);
      if ((await tx.execute(sql`SELECT 1 FROM support_messages WHERE id = ${note}`)).rows.length) return 0;
      if ((await tx.execute(sql`SELECT 1 FROM support_messages WHERE conversation_id = ${id} AND email_from IS NOT NULL AND created_at > now() - interval '1 hour' LIMIT ${STAFF_NOTES_PER_HOUR}`)).rows.length >= STAFF_NOTES_PER_HOUR) return 'limited';
      await tx.execute(sql`WITH c AS (UPDATE support_conversations SET messages = messages + 1 WHERE id = ${id} RETURNING messages)
        INSERT INTO support_messages(id, conversation_id, seq, author, kind, text, staff_user_id, email_from) SELECT ${note}, ${id}, c.messages, 'staff', 'note', ${text}, ${operator?.user_id ?? null}, ${evidence.from} FROM c`);
      return 1;
    });
    if (made === 'limited') limited++; else notes += made;
  }
  if (!notes && limited) return ignored('limited');
  log('info', { code: 'SUPPORT_STAFF_REPLY_NOTED', notes, by: operator ? 'operator' : 'team' });
  return { reply: true, notes, ignored: null };
}

/**
 * One failed try to send a staff email: its count and the error's code. After STAFF_MAIL_LIMITS.attempts it failed for
 * good (failed_at): the sweep never offers it again. One already sent changes nothing.
 */
export async function staffMailFailed(db: DbExecutor, key: string, code: string) {
  const { rows: [row] } = await db.execute<{ attempts: number; failed: boolean; sent: boolean }>(sql`UPDATE support_staff_emails SET
      attempts = attempts + CASE WHEN sent_at IS NULL THEN 1 ELSE 0 END, last_error = CASE WHEN sent_at IS NULL THEN ${code} ELSE last_error END,
      failed_at = CASE WHEN sent_at IS NULL AND attempts + 1 >= ${STAFF_MAIL_LIMITS.attempts} THEN coalesce(failed_at, now()) ELSE failed_at END
    WHERE key = ${key} RETURNING attempts, failed_at IS NOT NULL AS failed, sent_at IS NOT NULL AS sent`);
  return row ?? notFound('Staff email');
}

const StaffEmail = z.object({
  key: z.string().describe('The send\u2019s Idempotency-Key: the same email under the same key on every try.'),
  threadId: z.string().nullable().describe('The thread to reply in (an update), or null to start one.'), replyToMessageId: z.string().nullable(),
  subject: z.string(), text: z.string(), html: z.string(),
}).openapi('SupportStaffEmail');
const Key = z.object({ key: z.string().regex(/^staff-[0-9a-f]{24}-[0-9]{1,6}$/) });

export function registerSupportStaffMail(app: App) {
  const security: Record<string, string[]>[] = [{ bearerAuth: [] }];
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/support/staff-mail', operationId: 'operatorSupportStaffMail',
    description: 'The support platform\u2019s sweep (the binding only): writes the staff emails that are due, then answers every one not yet sent and not failed for good, oldest first. Send each from the support address to the team, then report it sent.',
    responses: { 200: response(z.object({ data: z.array(StaffEmail) })), ...errors } }), async c => {
    await supportPlatformOnly(c);
    await planStaffMail(c.env.db, c.env.config);
    const { rows } = await c.env.db.execute<{ key: string; seq: number; subject: string; text: string; html: string; thread_id: string | null; last_message_id: string | null }>(sql`SELECT e.key, e.seq, e.subject, e.text, e.html, t.thread_id, t.last_message_id
      FROM support_staff_emails e JOIN support_staff_threads t ON t.key = e.thread_key WHERE e.sent_at IS NULL AND e.failed_at IS NULL
        AND (t.thread_id IS NOT NULL OR NOT EXISTS (SELECT FROM support_staff_emails p WHERE p.thread_key = e.thread_key AND p.seq < e.seq AND p.failed_at IS NULL))
      ORDER BY e.created_at, e.key LIMIT ${STAFF_MAIL_LIMITS.batch}`);
    // A reply in its thread once one of the thread's emails went; until then (its first, or the first after every earlier one failed for good) it starts the thread.
    return c.json({ data: rows.map(r => ({ key: r.key, threadId: r.thread_id, replyToMessageId: r.thread_id ? r.last_message_id : null, subject: r.subject, text: r.text, html: r.html })) }, 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/support/staff-mail/{key}/sent', operationId: 'operatorSupportStaffMailSent',
    description: 'The support platform sent this staff email (the binding only): its thread and message, so the thread\u2019s next email replies in it. Reporting it again changes nothing.',
    request: { params: Key, body: json(z.object({ threadId: z.string().min(1).max(120), messageId: z.string().min(1).max(120) }).strict()) },
    responses: { 200: response(z.object({ key: z.string(), sentAt: z.string() })), ...errors } }), async c => {
    await supportPlatformOnly(c);
    const { key } = c.req.valid('param'), body = c.req.valid('json');
    const sentAt = await c.env.db.transaction(async tx => {
      const { rows: [email] } = await tx.execute<{ thread_key: string; sent_at: string; fresh: boolean }>(sql`UPDATE support_staff_emails SET sent_at = coalesce(sent_at, now()), failed_at = NULL, message_id = coalesce(message_id, ${body.messageId})
        WHERE key = ${key} RETURNING thread_key, sent_at::text AS sent_at, message_id = ${body.messageId} AS fresh`);
      if (!email) notFound('Staff email');
      if (email!.fresh) await tx.execute(sql`UPDATE support_staff_threads SET thread_id = coalesce(thread_id, ${body.threadId}), last_message_id = ${body.messageId}, last_sent_at = ${email!.sent_at}::timestamptz WHERE key = ${email!.thread_key}`);
      return email!.sent_at;
    });
    return c.json({ key, sentAt: new Date(sentAt).toISOString() }, 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/support/staff-mail/{key}/failed', operationId: 'operatorSupportStaffMailFailed',
    description: `The support platform could not send this staff email (the binding only): one failed try, and the error's code. After ${STAFF_MAIL_LIMITS.attempts} it failed for good: never offered again, and not sent on Glass until its thread has an email that goes. One already sent changes nothing.`,
    request: { params: Key, body: json(z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/) }).strict()) },
    responses: { 200: response(z.object({ key: z.string(), attempts: z.number().int(), failed: z.boolean(), sent: z.boolean() })), ...errors } }), async c => {
    await supportPlatformOnly(c);
    const { key } = c.req.valid('param'), row = await staffMailFailed(c.env.db, key, c.req.valid('json').code);
    if (row.failed && !row.sent) log('warn', { code: 'SUPPORT_STAFF_MAIL_NOT_SENT', attempts: row.attempts });
    return c.json({ key, ...row }, 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/support/staff-mail/replies', operationId: 'operatorSupportStaffMailReply',
    description: 'Before the support platform treats an email to a support address as a customer\u2019s (the binding only): whether it replies to a staff email, and if so the internal note it became, or why it became none. reply false: handle it as any support email. reply true: never a conversation, never answered.',
    request: { body: json(z.object({ messageId: z.string().regex(/^msg_[0-9a-f]{32}$/), team: z.string().trim().max(320).nullable().describe('The team address the support platform sends staff email to (TICKET_TO).') }).strict()) },
    responses: { 200: response(z.object({ reply: z.boolean(), notes: z.number().int().optional(), ignored: z.enum(['unverified', 'not_staff', 'no_conversation', 'empty', 'automated', 'limited']).nullable().optional() })), ...errors } }), async c => {
    await supportPlatformOnly(c);
    const body = c.req.valid('json');
    return c.json(await staffReply(c.env.db, c.env.config, body.messageId, body.team), 200);
  });
}
