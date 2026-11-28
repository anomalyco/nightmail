import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { ApiError, dashboardSession, denied, digest, errors, json, log, notFound, response, type App, type Ctx, type DbExecutor } from './core.js';
import { auditContext, auditInsert, operatorContext, recordAudit, requireOperator } from './audit.js';
import { CONVERSATION_ID, verifyHandoffToken, type RegisteredConversation } from './support-platform.js';
import type { MailHeader, Verdicts } from './db/mailbox.js';
import { clientIpHeader, loopHeaderNames, productName } from './brand.js';
import { mailboxProven } from './account-policy.js';

// Support conversations (api/README.md "Support integration"). The support platform registers each chat or email
// conversation it holds; Nightmail alone decides who it is for, from evidence it checks itself:
//
// - chat: its own signed handoff (POST /v1/contact-support) and the unused handoff row, once;
// - email: a message it received at a support address (NIGHTMAIL_SUPPORT_ADDRESS_IDS) binds its sender's account only
//   when ingest vouched for its one literal From, SES's DMARC verdict is PASS, that From is exactly one account's verified
//   email (the local part byte for byte, the domain in any case) and the account has a workspace (emailEvidence);
// - sign-in: for any other message, the person's own dashboard session, when its verified email is the message's sender,
//   confirms that one message (the claim). It binds an unbound conversation, and is recorded per message.
//
// The support platform then reads through SupportPlatform.request(conversationId, …): the binding puts the conversation on
// the runtime, never in a header, query parameter or body, and supportGate (src/support.ts) answers for that user's live
// memberships within the conversation's scope, each route only for the roles its dashboard counterpart admits. An email
// conversation only reads (and narrows its workspace): the changes and notes routes are a chat's.

export type SupportRole = 'owner' | 'admin' | 'member';
const EVERYONE: SupportRole[] = ['owner', 'admin', 'member'], MANAGERS: SupportRole[] = ['owner', 'admin'];
type Ceiling = { method: 'GET' | 'POST'; path: string; roles: SupportRole[]; counterpart: string; views?: false; chatOnly?: true };
/**
 * Every /v1/support route a conversation may call: the roles whose workspaces it reads, and the dashboard route that
 * decides them. A role reads a workspace here exactly when its own session may call the counterpart there. A route
 * missing here is refused to every conversation. `views: false`: reading it names no workspace's data, so it writes no
 * customer-visible "support viewed" row. `chatOnly`: an email conversation is refused (it proposes nothing, keeps no notes, and
 * reads only the account's status, domains and sending: never billing, the activity trail, request logs, webhooks or
 * receiving configuration).
 */
export const SUPPORT_CEILINGS: Ceiling[] = [
  // Its domains, webhook failures and activity follow their own counterparts (CONTEXT_SECTIONS).
  { method: 'GET', path: '/v1/support/context', roles: EVERYONE, counterpart: 'GET /v1/me' },
  { method: 'GET', path: '/v1/support/workspaces', roles: EVERYONE, counterpart: 'GET /v1/me' },
  { method: 'GET', path: '/v1/support/domains', roles: MANAGERS, counterpart: 'GET /v1/domains' },
  // Individual mail, delivery events, campaigns, screens and audience metadata require a signed-in dashboard chat.
  { method: 'GET', path: '/v1/support/emails', roles: EVERYONE, counterpart: 'GET /v1/emails', chatOnly: true },
  { method: 'GET', path: '/v1/support/emails/{id}', roles: EVERYONE, counterpart: 'GET /v1/emails', chatOnly: true },
  { method: 'GET', path: '/v1/support/events', roles: EVERYONE, counterpart: 'GET /v1/emails', chatOnly: true },
  // Email reads the account's status, domains and sending only (chatOnly): webhooks, billing, the activity trail and request
  // logs are a chat's, in the dashboard's Help.
  { method: 'GET', path: '/v1/support/webhook-deliveries', roles: MANAGERS, counterpart: 'GET /v1/webhooks', chatOnly: true },
  { method: 'GET', path: '/v1/support/standing', roles: EVERYONE, counterpart: 'GET /v1/sender-score' },
  { method: 'GET', path: '/v1/support/billing', roles: MANAGERS, counterpart: 'GET /v1/billing/ledger', chatOnly: true },
  { method: 'GET', path: '/v1/support/audit', roles: MANAGERS, counterpart: 'GET /v1/activity', chatOnly: true },
  // Request lines and traces show the whole workspace's API activity and its audit entries.
  { method: 'GET', path: '/v1/support/requests', roles: MANAGERS, counterpart: 'GET /v1/activity', chatOnly: true },
  { method: 'GET', path: '/v1/support/requests/{requestId}', roles: MANAGERS, counterpart: 'GET /v1/activity', chatOnly: true },
  { method: 'GET', path: '/v1/support/deliverability/metrics', roles: EVERYONE, counterpart: 'GET /v1/metrics' },
  { method: 'GET', path: '/v1/support/deliverability/bounces', roles: EVERYONE, counterpart: 'GET /v1/metrics' },
  { method: 'GET', path: '/v1/support/domains/{id}/health', roles: MANAGERS, counterpart: 'GET /v1/domains' },
  // Actions (src/support-actions.ts): every kind's public route, and the domain re-check's, needs an owner or admin.
  { method: 'POST', path: '/v1/support/actions', roles: MANAGERS, counterpart: 'GET /v1/webhooks', chatOnly: true },
  { method: 'GET', path: '/v1/support/actions/{id}', roles: MANAGERS, counterpart: 'GET /v1/webhooks', chatOnly: true },
  { method: 'POST', path: '/v1/support/domains/{id}/verify', roles: MANAGERS, counterpart: 'GET /v1/domains', chatOnly: true },
  // Safe actions the agent takes alone (support-actions.ts): a receiving host's Check MX now is its domain's Check now; a
  // forward's Send again is an endpoint's. Risky changes it only proposes to staff, for a workspace it may act for.
  { method: 'POST', path: '/v1/support/receiving/hosts/{id}/recheck', roles: MANAGERS, counterpart: 'GET /v1/domains', chatOnly: true },
  { method: 'POST', path: '/v1/support/receiving/forwards/{id}/resend', roles: MANAGERS, counterpart: 'GET /v1/endpoints', chatOnly: true },
  { method: 'POST', path: '/v1/support/approvals', roles: MANAGERS, counterpart: 'GET /v1/api-keys', chatOnly: true },
  { method: 'GET', path: '/v1/support/screen', roles: EVERYONE, counterpart: 'GET /v1/emails', chatOnly: true },
  { method: 'GET', path: '/v1/support/campaigns', roles: EVERYONE, counterpart: 'GET /v1/campaigns', chatOnly: true },
  { method: 'GET', path: '/v1/support/campaigns/{id}', roles: EVERYONE, counterpart: 'GET /v1/campaigns', chatOnly: true },
  { method: 'GET', path: '/v1/support/emails/{id}/lint', roles: EVERYONE, counterpart: 'GET /v1/emails', chatOnly: true },
  { method: 'GET', path: '/v1/support/campaigns/{id}/lint', roles: EVERYONE, counterpart: 'GET /v1/campaigns', chatOnly: true },
  { method: 'GET', path: '/v1/support/audience/health', roles: EVERYONE, counterpart: 'GET /v1/lists', chatOnly: true },
  // Receiving (src/support-receiving.ts) is an owner's or admin's in the dashboard. Its hosts are a domain's status, which
  // email reads too; routes, endpoints and held addresses are receiving configuration, a chat's. Receiving domains and
  // releasing a held address are behind mailbox.ts admin(); GET /v1/inbound/policy is that same gate without the region
  // settings the domains list also needs, so it stands in for both.
  { method: 'GET', path: '/v1/support/receiving/hosts', roles: MANAGERS, counterpart: 'GET /v1/inbound/policy' },
  { method: 'GET', path: '/v1/support/receiving/routes', roles: MANAGERS, counterpart: 'GET /v1/routing', chatOnly: true },
  { method: 'GET', path: '/v1/support/receiving/retired', roles: MANAGERS, counterpart: 'GET /v1/inbound/policy', chatOnly: true },
  { method: 'GET', path: '/v1/support/receiving/forwards', roles: MANAGERS, counterpart: 'GET /v1/endpoints', chatOnly: true },
  // SMTP refusals (src/smtp-refusals.ts): mail apps sign in with app passwords and send-only keys, an owner's or admin's
  // in the dashboard (API keys). Each names the reply the app got, which can name an attached file: a chat's.
  { method: 'GET', path: '/v1/support/smtp/refusals', roles: MANAGERS, counterpart: 'GET /v1/api-keys', chatOnly: true },
  { method: 'GET', path: '/v1/support/scope', roles: EVERYONE, counterpart: 'GET /v1/me', views: false },
  { method: 'POST', path: '/v1/support/scope', roles: EVERYONE, counterpart: 'GET /v1/me', views: false },
  // Notes are the person's own (src/support-notes.ts), filtered by their memberships, never a workspace's data.
  { method: 'GET', path: '/v1/support/notes', roles: EVERYONE, counterpart: 'GET /v1/me', views: false, chatOnly: true },
  { method: 'POST', path: '/v1/support/notes', roles: EVERYONE, counterpart: 'GET /v1/me', views: false, chatOnly: true },
];
/** The parts of GET /v1/support/context that follow another counterpart than the route's own. */
export const CONTEXT_SECTIONS = {
  domains: { roles: MANAGERS, counterpart: 'GET /v1/domains' },
  webhookDeliveries: { roles: MANAGERS, counterpart: 'GET /v1/webhooks' },
  recentActivity: { roles: MANAGERS, counterpart: 'GET /v1/activity' },
} as const;
// A parameter is one ID segment (prefix_hex, base32 or SES message IDs): never a dot, a percent escape or a separator.
const compiled = SUPPORT_CEILINGS.map(entry => ({ ...entry, pattern: new RegExp(`^${entry.path.replace(/\{[^}]+\}/g, '[A-Za-z0-9_-]{1,120}')}$`) }));
/** The ceiling of a concrete request (HEAD reads like GET), or undefined: a conversation may not call it. */
export const ceilingFor = (method: string, path: string) => {
  const verb = method === 'HEAD' ? 'GET' : method;
  return compiled.find(entry => entry.method === verb && entry.pattern.test(path));
};
/** The workspaces of a conversation's scope whose role reads this context section. */
export function sectionIds(section: keyof typeof CONTEXT_SECTIONS, workspaces: { id: string; role: SupportRole }[]) {
  const roles: readonly SupportRole[] = CONTEXT_SECTIONS[section].roles;
  return workspaces.filter(w => roles.includes(w.role)).map(w => w.id);
}
/** A conversation's workspaces where it reads received mail as a member does: only mail on receiving addresses. */
export const routedOnly = (workspaces: { id: string; role: SupportRole }[]) => workspaces.filter(w => w.role === 'member').map(w => w.id);

/** Open chats per person, checked when a handoff opens one. */
export const OPEN_CONVERSATIONS = 10;
/** Open email conversations bound to a person, a cap of their own (checked at registration and at a claim), so mail can never keep them out of a chat. */
export const OPEN_EMAIL_CONVERSATIONS = 10;
/** How long the person may confirm, signed in, one email support couldn't verify; unsigned sign-ins go then (maintenance.ts). */
export const SIGNIN_DAYS = 7;
/** How far a message's Date may be from its receipt for it to bind an account: older (or later) mail asks for a sign-in. */
const SENT_WITHIN_DAYS = 3;
const Mode = z.enum(['member', 'non_member', 'pending_signin', 'unverified']);
const Registered = z.object({
  id: z.string(), channel: z.enum(['chat', 'email']), mode: Mode.describe('member: reads the account by role; non_member: general answers; pending_signin and unverified: the same fixed reply with a sign-in for that message, then (generalAnswer, nobody claimed it in time) a general answer.'),
  verification: z.enum(['handoff', 'dmarc', 'signin', 'none', 'agent']), status: z.enum(['open', 'ticketed', 'closed']),
  workspaceId: z.string().nullable().describe('The one workspace in scope: a chat’s, or the one an email narrowed to. Null: every membership.'),
  contentShared: z.boolean().describe('Whether the customer let support read message content (a chat, in its own workspace).'),
  created: z.boolean().describe('False when this registration repeated or added to an earlier one.'),
  generalAnswer: z.boolean().optional().describe('Email only: whether this message passed the sender checks a general answer needs (a From that DMARC verified, not sent through Nightmail itself, not a replay). A message waiting for its sender\u2019s sign-in gets a general answer when nobody claims it only then.'),
}).openapi('SupportConversationRegistration');
type Row = { id: string; channel: 'chat' | 'email'; mode: z.infer<typeof Mode>; verification: RegisteredConversation['verification']; status: RegisteredConversation['status']; workspace_id: string | null;
  content_workspace_id: string | null; user_id: string | null; pending_address: string | null };
const view = (row: Row, created: boolean, generalAnswer?: boolean): RegisteredConversation => ({ id: row.id, channel: row.channel, mode: row.mode, verification: row.verification, status: row.status,
  workspaceId: row.workspace_id, contentShared: !!row.content_workspace_id, created, ...generalAnswer === undefined ? {} : { generalAnswer } });
const columns = sql`id, channel, mode, verification, status, workspace_id, content_workspace_id, user_id, pending_address`;
/** The support platform's service binding, and nothing else: an operator's own session gets 403 too. */
export const supportPlatformOnly = async (c: Ctx) => {
  const operator = await requireOperator(c, 'operator:read');
  if (operator.via !== 'support') throw new ApiError(403, 'SUPPORT_PLATFORM_REQUIRED', 'Only the support platform makes this call, through its service binding.');
  return operator;
};
const limitReached = (channel: 'chat' | 'email') => new ApiError(429, 'SUPPORT_CONVERSATION_LIMIT', channel === 'chat' ? `This person already has ${OPEN_CONVERSATIONS} open support chats. Close one first.`
  : `This person already has ${OPEN_EMAIL_CONVERSATIONS} open email support conversations. One must end first.`);
// Not the conversations Nightmail opened for their agents' reports (verification 'agent'): those have their own daily
// caps (src/feedback.ts FEEDBACK_ANSWERS) and never take the room of the person's own email.
const openCount = (userId: unknown, channel: 'chat' | 'email') => sql`(SELECT count(*)::int FROM support_conversations WHERE user_id = ${userId} AND channel = ${channel} AND status <> 'closed' AND verification <> 'agent')`;
/**
 * Serializes admission for one person: every path that sets user_id (a handoff, an email, a claim) takes this lock first, before
 * any conversation or handoff row, so its count is a later statement that sees every admission committed before it.
 */
const admit = (tx: DbExecutor, userId: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 39601))`);
export const admitPerson = admit;

/** Printable ASCII: only such an address is compared for an account (a Unicode one never binds; it can sign in). */
const ASCII = /^[\x21-\x7e]+$/;
const split = (address: string) => { const at = address.lastIndexOf('@'); return [address.slice(0, at), address.slice(at + 1)] as const; };
/** A header field name as RFC 5322 defines it: printable ASCII but the colon, nothing around it (no space or tab). */
const FIELD_NAME = /^[\x21-\x39\x3b-\x7e]+$/;
/** The address of a From field literalFrom accepted, as it was written (case kept): the field itself, or its trailing <…>. */
const writtenAddress = (field: string) => { const value = field.trim(); return value.endsWith('>') ? value.slice(value.lastIndexOf('<') + 1, -1) : value; };
/** The same mailbox: the local part byte for byte (a mail server may tell cases apart), the domain in any case. */
export function sameMailbox(a: string, b: string) {
  if (!ASCII.test(a) || !ASCII.test(b) || !/^[^\s@]+@[^\s@]+$/.test(a) || !/^[^\s@]+@[^\s@]+$/.test(b)) return false;
  const [localA, domainA] = split(a), [localB, domainB] = split(b);
  return localA === localB && domainA.toLowerCase() === domainB.toLowerCase();
}

/**
 * What a message Nightmail received at a support address proves, and whose account it binds. Its sender is verified when
 * that From is the one literal address SES's DMARC PASS vouches for, as ingest judged it for every support address it
 * reached (the link's reply_author_verified) and as the stored verdict says, and every header has a well-formed name;
 * anything less, or ambiguous, proves nothing. A verified sender binds an account only when all of these hold too:
 * - the From, as written (case kept, plain ASCII), is exactly one account's verified email (sameMailbox);
 * - a sign-in proved that address is the person's mailbox within MAILBOX_PROOF_DAYS (account-policy.ts mailboxProven);
 * - the message was written to support: a support address in its one To or Cc field, one Date within SENT_WITHIN_DAYS
 *   of its receipt, and one Message-ID (which binds that account once: registration checks it);
 * - the account has a live workspace membership.
 * Then `member` (userId). Otherwise:
 * - `non_member`: verified, but no such account, or one without a workspace (general answers);
 * - `pending_signin`: an account's address (up to case) that doesn't bind;
 * - `unverified`: anything else.
 * The last two get the same fixed reply, with a sign-in for this message (`signIn`). `generalAnswer`: the sender checks a
 * general answer needs (`non_member`'s: verified, and not sent through Nightmail itself), which also decide whether a
 * message waiting for its sign-in gets a general answer when nobody claims it. dkimAligned records whether a sole
 * signature of the From domain passed too.
 */
export async function emailEvidence(db: DbExecutor, addressIds: string[], messageId: string) {
  const { rows: [m] } = await db.execute<{ thread_id: string; from_address: string; verdicts: Verdicts; headers: MailHeader[]; author_verified: boolean | null; rfc_message_id: string | null;
    ses_message_id: string | null; sending_email_id: string | null; addressed: boolean; recent: boolean }>(sql`SELECT m.thread_id, m.from_address, m.verdicts, m.headers, m.message_id AS rfc_message_id,
      m.ses_message_id, m.sending_email_id, links.author_verified,
      EXISTS (SELECT FROM jsonb_array_elements(m."to" || m.cc) r WHERE lower(r->>'address') IN (
        SELECT lower(b.address) FROM mailboxes b WHERE b.id = ANY(${sql.param(addressIds)}::text[])
        UNION SELECT lower(a.address) FROM mailbox_addresses a WHERE a.mailbox_id = ANY(${sql.param(addressIds)}::text[]))) AS addressed,
      coalesce(abs(extract(epoch FROM m.received_at - m.sent_at)) <= ${SENT_WITHIN_DAYS * 86_400}, false) AS recent
    FROM mail_messages m
    CROSS JOIN LATERAL (SELECT bool_and(mm.reply_author_verified) AS author_verified FROM mailbox_messages mm JOIN mailboxes b ON b.id = mm.mailbox_id AND b.workspace_id = mm.workspace_id
      WHERE mm.message_id = m.id AND mm.workspace_id = m.workspace_id AND mm.direction = 'inbound' AND mm.mailbox_id = ANY(${sql.param(addressIds)}::text[])) links
    WHERE m.id = ${messageId} AND m.direction = 'inbound' AND links.author_verified IS NOT NULL`);
  if (!m) return null;
  const { literalFrom, soleAlignedSignature } = await import('./mailbox-ingest.js');
  const from = m.from_address.trim().toLowerCase(), domain = from.split('@')[1] ?? '', field = (name: string) => m.headers.filter(h => h.name.toLowerCase() === name).map(h => h.value);
  const fromFields = field('from'), dmarc = m.verdicts?.dmarc ?? null, names = m.headers.every(h => FIELD_NAME.test(h.name));
  const verified = /^[^\s@]+@[^\s@]+$/.test(from) && names && fromFields.length === 1 && literalFrom(fromFields[0]!, from) && dmarc === 'PASS' && m.author_verified === true;
  const written = verified ? writtenAddress(fromFields[0]!) : '';
  const addressed = m.addressed && field('to').length <= 1 && field('cc').length <= 1 && field('date').length === 1 && m.recent && field('message-id').length === 1 && !!m.rfc_message_id;
  const dkimAligned = m.verdicts?.dkim === 'PASS' && soleAlignedSignature(field('dkim-signature'), domain);
  // Mail sent through Nightmail itself does not count as authorship proof; require a signed-in confirmation instead.
  let selfSent = Boolean(m.sending_email_id) || m.headers.some(h => loopHeaderNames.includes(h.name.toLowerCase()));
  if (!selfSent && verified && domain) {
    const labels = domain.split('.'), domains: string[] = [];
    for (let i = 0; i <= labels.length - 2; i++) domains.push(labels.slice(i).join('.'));
    const rfc = m.rfc_message_id?.replace(/^<|>$/g, '').trim() ?? '';
    const rfcLocal = rfc.includes('@') ? rfc.slice(0, rfc.indexOf('@')) : rfc;
    const providerCandidates = [...new Set([rfcLocal, m.ses_message_id ?? ''].filter(Boolean))];
    const { rows: [sent] } = await db.execute<{ own: boolean }>(sql`WITH claimants AS (
        SELECT DISTINCT workspace_id FROM domain_claims WHERE name = ANY(${sql.param(domains)}::text[])
      ) SELECT (
        (${providerCandidates.length > 0}::boolean AND EXISTS (
          SELECT FROM sending_emails e JOIN claimants c ON c.workspace_id = e.workspace_id
          WHERE e.provider_id = ANY(${sql.param(providerCandidates)}::text[])
        )) OR (${Boolean(rfc)}::boolean AND EXISTS (
          SELECT FROM mail_message_ids mid JOIN claimants c ON c.workspace_id = mid.workspace_id
          JOIN mail_messages om ON om.id = mid.mail_message_id AND om.workspace_id = mid.workspace_id
          WHERE mid.message_id = ${rfc} AND om.direction = 'outbound'
        ))
      ) AS own`);
    selfSent = Boolean(sent?.own);
  }
  // Verified addresses are unique in any case (account-login.ts), so at most one account can match.
  const { rows: owners } = await db.execute<{ id: string; email: string; memberships: number; proven: boolean }>(sql`SELECT u.id, u.email, ${mailboxProven(sql`u`)} AS proven,
      (SELECT count(*)::int FROM workspace_members wm WHERE wm.user_id = u.id) AS memberships
    FROM nightmail_users u WHERE u.email_verified AND lower(u.email) = ${from} LIMIT 2`);
  const owner = owners.length === 1 ? owners[0]! : null, exact = !!owner && sameMailbox(owner.email.trim(), written);
  const generalAnswer = verified && !selfSent, eligible = generalAnswer && exact && owner!.proven && addressed;
  const userId = eligible && owner!.memberships > 0 ? owner!.id : null;
  const mode: Row['mode'] = userId ? 'member' : generalAnswer && (!owner || eligible) ? 'non_member' : owners.length ? 'pending_signin' : 'unverified';
  return { from, threadId: m.thread_id, userId, mode, signIn: mode === 'pending_signin' || mode === 'unverified', generalAnswer, verification: verified ? 'dmarc' as const : 'none' as const,
    rfcMessageId: m.rfc_message_id, evidence: { message: messageId, dmarc, dkimAligned, mailboxProven: !!owner?.proven, addressed, ...(selfSent ? { selfSent: true } : {}) } };
}
/** The same email again, for an account it already bound (a replay of a signed copy): it binds nobody, asks for a sign-in, and gets no general answer meanwhile (it was answered once). */
const replayed = (found: NonNullable<Awaited<ReturnType<typeof emailEvidence>>>) => ({ ...found, userId: null, mode: 'pending_signin' as Row['mode'], signIn: true, generalAnswer: false, evidence: { ...found.evidence, replayed: true } });

/**
 * The sign-in one email waits for, as the person signed in may see or confirm it: the conversation an open email one with
 * nobody else bound to it, the sign-in recorded for that message within SIGNIN_DAYS and nobody else's, its address this
 * person's verified email (in any case), and that address a mailbox they proved (mailboxProven). Null for anyone else.
 */
async function signinFor(db: DbExecutor, conversationId: string, messageId: string, user: { userId: string; email: string }, lock: boolean) {
  const { rows: [target] } = await db.execute<{ user_id: string | null; mode: z.infer<typeof Mode>; address: string; signed_by: string | null; first: boolean; subject: string | null; text: string | null; received_at: string | null }>(sql`SELECT s.user_id, s.mode,
      si.address, si.user_id AS signed_by, si.signed_in_at IS NULL AS first, m.subject, m.text, m.received_at::text
    FROM support_conversations s JOIN support_email_signins si ON si.conversation_id = s.id AND si.message_id = ${messageId}
    JOIN nightmail_users u ON u.id = ${user.userId} AND ${mailboxProven(sql`u`)}
    LEFT JOIN mail_messages m ON m.id = si.message_id AND m.direction = 'inbound'
    WHERE s.id = ${conversationId} AND s.channel = 'email' AND s.status <> 'closed' AND si.created_at > now() - make_interval(days => ${SIGNIN_DAYS}::int)
    ${lock ? sql`FOR UPDATE OF s, si` : sql``}`);
  if (!target || target.address.toLowerCase() !== user.email.trim().toLowerCase() || (target.signed_by ?? user.userId) !== user.userId || (target.user_id ?? user.userId) !== user.userId) return null;
  return target;
}

/** The address one email's sign-in waits for, while it can still be confirmed (signinFor's checks but the person's), or null. */
async function waitingAddress(db: DbExecutor, conversationId: string, messageId: string) {
  const { rows: [row] } = await db.execute<{ address: string }>(sql`SELECT si.address FROM support_conversations s
    JOIN support_email_signins si ON si.conversation_id = s.id AND si.message_id = ${messageId}
    WHERE s.id = ${conversationId} AND s.channel = 'email' AND s.status <> 'closed' AND si.created_at > now() - make_interval(days => ${SIGNIN_DAYS}::int)`);
  return row?.address ?? null;
}
/** An address as it is shown to someone who hasn't proved it: its first character and its domain's, and the last label (r•••@e•••.com). */
export function maskedAddress(address: string) {
  const at = address.lastIndexOf('@'), domain = address.slice(at + 1), dot = domain.lastIndexOf('.'), first = (part: string) => [...part][0] ?? '';
  return `${first(address.slice(0, at))}•••@${first(domain)}•••${dot > 0 ? domain.slice(dot) : ''}`;
}
/** The address as this session may see it: whole when its own sign-in proved that mailbox, else masked. */
async function shownAddress(c: Ctx, address: string) {
  const { accountSessionMailbox } = await import('./account-login.js');
  return (await accountSessionMailbox(c.env, c.req.raw.headers))?.toLowerCase() === address.toLowerCase() ? address : maskedAddress(address);
}
/**
 * A session whose sign-in proves no mailbox (403 MAILBOX_SIGN_IN_REQUIRED) asks about an email that still waits for its
 * sender: the refusal says the way through, in error.details[0] (address: where the email came from, as shownAddress shows
 * it; nextStep: the request that emails a sign-in link there). It stays 403 and not retryable: asking again as it is gets
 * the same. For an email that waits for nobody it is the plain 403.
 */
async function mailboxStep(c: Ctx, error: unknown, conversationId: string, messageId: string) {
  if (!(error instanceof ApiError) || error.code !== 'MAILBOX_SIGN_IN_REQUIRED') return error;
  const address = await waitingAddress(c.env.db, conversationId, messageId);
  error.retryable = false;
  if (address) error.details = [{ address: await shownAddress(c, address),
    nextStep: { operationId: 'sendSupportSignInLink', method: 'POST', path: `/v1/support-conversations/${conversationId}/sign-in-link`, body: { messageId } } }];
  return error;
}
/** Sign-in links one email's Continue page may have sent (POST …/sign-in-link), a day: per conversation, and per address over every conversation. */
export const SUPPORT_LINKS = { perConversation: 3, perAddress: 5 } as const;
/** "Answer me by email instead" requests per conversation and per network: auth_state_slots' 8 in 11 minutes. */
const ANSWER_SLOTS = 8;

/** What releaseGeneralAnswer did. */
export type GeneralAnswerRelease = 'released' | 'already_answered' | 'already_released' | 'not_waiting';
/** How long a release stays on the support platform's due list (GET /v1/operator/support/general-answers) unanswered. */
const RELEASE_DUE = sql`interval '1 day'`;
/**
 * "Answer me by email instead": the sender of an email support couldn't verify, waiting for a sign-in that can't come
 * (an address with no account, mail that fails the sender checks), opened the sign-in link emailed to the conversation's
 * address and pressed it. That is the mailbox proof the sender checks couldn't give, so the conversation is due at once,
 * without them, for the support platform's general-answers-only turn: no account tools, reads or data in the answer; a
 * ticket and the staff email when it can't answer that way. The answer goes to the conversation's address, in its
 * thread, and covers every email of theirs still waiting there. Once per conversation. In the caller's transaction (the
 * row lock serializes presses); after it commits, wake the support platform (support-inbox.ts wakeSupport) as the claim
 * does, and its sweep finds the release anyway (GET /v1/operator/support/general-answers).
 * - released: due now; its waiting emails are owed a reply from now (No reply sent);
 * - already_released: this conversation was released before;
 * - already_answered: something already answered that email (the automatic general answer, a staff reply);
 * - not_waiting: no such email waiting for a sign-in in an open email conversation (unknown, claimed, closed, or past SIGNIN_DAYS).
 */
export async function releaseGeneralAnswer(tx: DbExecutor, conversationId: string, messageId: string): Promise<GeneralAnswerRelease> {
  if (!CONVERSATION_ID.test(conversationId) || !/^msg_[0-9a-f]{32}$/.test(messageId)) return 'not_waiting';
  const { reached } = await import('./support-inbox.js');
  const { rows: [row] } = await tx.execute<{ signed: boolean; released: boolean; answered: boolean }>(sql`SELECT si.signed_in_at IS NOT NULL AS signed,
      EXISTS (SELECT FROM support_email_signins r WHERE r.conversation_id = s.id AND r.general_answer_requested_at IS NOT NULL) AS released,
      EXISTS (SELECT FROM support_messages o WHERE o.conversation_id = s.id AND ${reached}
        AND (o.seq > email.seq OR (email.seq IS NULL AND o.created_at >= si.created_at))) AS answered
    FROM support_conversations s JOIN support_email_signins si ON si.conversation_id = s.id AND si.message_id = ${messageId}
    -- The email as the inbox holds it (absent while its mirror is behind: then whatever came after it was registered).
    LEFT JOIN LATERAL (SELECT max(m.seq) AS seq FROM support_messages m WHERE m.conversation_id = s.id AND m.author = 'customer' AND m.source_message_id = si.message_id) email ON true
    WHERE s.id = ${conversationId} AND s.channel = 'email' AND s.status <> 'closed' AND si.created_at > now() - make_interval(days => ${SIGNIN_DAYS}::int)
    FOR UPDATE OF s, si`);
  if (!row || row.signed) return 'not_waiting';
  if (row.released) return 'already_released';
  if (row.answered) return 'already_answered';
  await tx.execute(sql`UPDATE support_email_signins SET general_answer_requested_at = clock_timestamp() WHERE conversation_id = ${conversationId} AND message_id = ${messageId}`);
  return 'released';
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const random32 = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => BASE32[b & 31]).join('');
/**
 * The support chat couldn't take a message (it couldn't start, its service couldn't be reached, or it dropped after the
 * person sent it), so the dashboard filed it (POST /v1/contact-support with ticket). It goes into this person's open chat
 * in this workspace, the one the Help panel continues, or opens one from the handoff (evidence.filed), as a customer
 * message of kind filed, with a ticket of type staff (Needs you) unless one is open, and the agent paused for it. The
 * same words again within the hour are the same message (a retry, or the support platform mirrored it before the chat
 * dropped): not stored twice, but back in Needs you all the same. In the caller's transaction, after the handoff row,
 * which it marks used for that conversation.
 *
 * Nothing calls the support platform from here, so it works while the platform is down: the inbox is Nightmail's own, and
 * a staff reply waits in the outbox. The platform adopts a conversation it doesn't hold and takes the filed messages into
 * its transcript from GET /v1/operator/support/conversations/{id}/filed (when the panel resumes it, or a staff reply
 * wakes it).
 */
export async function fileChatTicket(tx: DbExecutor, input: { userId: string; workspaceId: string; handoffId: string; text: string }) {
  await admit(tx, input.userId);
  const { rows: [open] } = await tx.execute<{ id: string; messages: number }>(sql`SELECT id, messages FROM support_conversations
    WHERE channel = 'chat' AND user_id = ${input.userId} AND workspace_id = ${input.workspaceId} AND status <> 'closed'
    ORDER BY coalesce(last_message_at, created_at) DESC, created_at DESC, id DESC LIMIT 1 FOR NO KEY UPDATE`);
  let conversation = open;
  if (!conversation) {
    if ((await tx.execute<{ n: number }>(sql`SELECT ${openCount(input.userId, 'chat')} AS n`)).rows[0]!.n >= OPEN_CONVERSATIONS) throw limitReached('chat');
    conversation = { id: `conv_${random32(26)}`, messages: 0 };
    await tx.execute(sql`INSERT INTO support_conversations(id, channel, user_id, verification, evidence, mode, workspace_id)
      VALUES (${conversation.id}, 'chat', ${input.userId}, 'handoff', ${JSON.stringify({ handoff: input.handoffId, filed: true })}::jsonb, 'member', ${input.workspaceId})`);
  }
  const { rows: [same] } = await tx.execute<{ id: string }>(sql`SELECT id FROM support_messages WHERE conversation_id = ${conversation.id} AND author = 'customer'
    AND text = ${input.text} AND created_at > now() - interval '1 hour' ORDER BY seq DESC LIMIT 1`);
  let messageId = same?.id;
  if (!messageId) {
    messageId = `msg_${random32(16)}`;
    await tx.execute(sql`INSERT INTO support_messages(id, conversation_id, seq, author, kind, text) VALUES (${messageId}, ${conversation.id}, ${conversation.messages + 1}, 'customer', 'filed', ${input.text})`);
    await tx.execute(sql`UPDATE support_conversations SET messages = messages + 1, last_message_at = now() WHERE id = ${conversation.id}`);
  }
  // Every filing brings a conversation staff marked done back to them, the same words again included: the person was
  // told it was filed.
  await tx.execute(sql`UPDATE support_conversations SET done_at = NULL, done_by = NULL WHERE id = ${conversation.id} AND done_at IS NOT NULL`);
  const [{ openStaffTicket }, { event }] = await Promise.all([import('./support-staff-mail.js'), import('./support-inbox.js')]);
  await openStaffTicket(tx, conversation.id, 'P2', true, { reason: 'chat_unavailable' });
  // The agent stops for the ticket, as after an emailed one: a person answers it, here or when the chat is back.
  const { rows: [paused] } = await tx.execute(sql`UPDATE support_conversations SET agent_state = 'paused', paused_by = 'ticket', paused_at = now() WHERE id = ${conversation.id} AND agent_state = 'active' RETURNING id`);
  if (paused) await tx.execute(event(conversation.id, 'paused', null, { by: 'ticket' }));
  await tx.execute(sql`UPDATE support_handoffs SET used_at = now(), conversation_id = ${conversation.id} WHERE id = ${input.handoffId}`);
  return { conversationId: conversation.id, messageId };
}

export function registerSupportConversations(app: App) {
  const operatorSecurity: Record<string, string[]>[] = [{ bearerAuth: [] }, { dashboardSession: [] }, { secureDashboardSession: [] }];
  const sessionSecurity: Record<string, string[]>[] = [{ dashboardSession: [] }, { secureDashboardSession: [] }];
  const ConversationParam = z.object({ id: z.string().regex(CONVERSATION_ID) });

  app.openapi(createRoute({ hide: true, tags: ['Operator'], security: operatorSecurity, method: 'post', path: '/v1/operator/support/conversations', operationId: 'operatorRegisterSupportConversation',
    description: 'The support platform registers a conversation (the binding only). Nightmail checks the evidence itself and decides who it is for. A handoff opens one conversation, once, for its person; an email registers again with each message, from its one sender, which may bind that sender’s account but never another, and never rebinds one.',
    request: { body: json(z.object({
      conversationId: z.string().regex(CONVERSATION_ID),
      evidence: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('handoff'), token: z.string().min(1).max(4096).describe('The signed handoff from "Contact support".') }).strict(),
        z.object({ kind: z.literal('email'), messageId: z.string().regex(/^msg_[0-9a-f]{32}$/).describe('A message Nightmail received at a support address.') }).strict(),
      ]),
    }).strict()) },
    responses: { 200: response(Registered), 201: response(Registered), ...errors } }), async c => {
    const operator = await supportPlatformOnly(c), body = c.req.valid('json'), context = operatorContext(c, operator), conversationId = body.conversationId;
    // A registration that binds a person is on their trail; one that binds nobody opens no access.
    const audit = (row: SQL, details: Record<string, unknown>) => auditInsert(context, { action: 'support.register', workspaceId: null, userId: sql`${row}.user_id`, target: { type: 'support_conversation', id: conversationId },
      details: { ...details, mode: sql`${row}.mode`, verification: sql`${row}.verification` }, ticketRef: conversationId, internal: true }, { from: row, where: sql`${row}.user_id IS NOT NULL` });

    if (body.evidence.kind === 'handoff') {
      const checked = await verifyHandoffToken(c.env.config, body.evidence.token);
      // A support channel this installation hasn't set up is a 404, not a server error: nothing failed, and the support
      // platform holds such work as blocked by configuration (support/src/work.ts) either way.
      if (!checked.ok) throw checked.code === 'SUPPORT_NOT_CONFIGURED' ? new ApiError(404, 'SUPPORT_NOT_CONFIGURED', 'Support chat is not set up here: set NIGHTMAIL_SUPPORT_SIGNING_KEY to sign and check handoffs.')
        : new ApiError(422, checked.code, checked.code === 'HANDOFF_EXPIRED' ? 'The handoff expired. The customer can contact support again.' : 'The handoff is not one this installation signed.', 'evidence.token');
      const claims = checked.claims;
      const result = await c.env.db.transaction(async tx => {
        await admit(tx, claims.userId);
        // A handoff opens one conversation (it is locked, then marked used in the same statement), for the
        // user and workspace it names, while they are still a member there.
        const { rows: [row] } = await tx.execute<Row & { handoff: boolean; used: boolean; used_by: string | null; is_member: boolean; taken: boolean }>(sql`WITH h AS (
            SELECT id, user_id, workspace_id, share_content, used_at, conversation_id FROM support_handoffs
            WHERE id = ${claims.id} AND user_id = ${claims.userId} AND workspace_id = ${claims.workspace.id} AND expires_at > now() FOR UPDATE
          ), member AS (SELECT FROM workspace_members m, h WHERE m.user_id = h.user_id AND m.workspace_id = h.workspace_id),
          c AS (
            INSERT INTO support_conversations(id, channel, user_id, verification, evidence, mode, workspace_id, content_workspace_id)
            SELECT ${conversationId}, 'chat', h.user_id, 'handoff', jsonb_build_object('handoff', h.id), 'member', h.workspace_id, CASE WHEN h.share_content THEN h.workspace_id END
            FROM h WHERE h.used_at IS NULL AND EXISTS (SELECT FROM member) AND ${openCount(sql`h.user_id`, 'chat')} < ${OPEN_CONVERSATIONS}
            ON CONFLICT (id) DO NOTHING RETURNING ${columns}
          ), used AS (UPDATE support_handoffs s SET used_at = now(), conversation_id = c.id FROM c WHERE s.id = ${claims.id}),
          logged AS (${audit(sql`c`, { channel: 'chat', handoff: claims.id })})
          SELECT c.*, EXISTS (SELECT FROM h) AS handoff, coalesce((SELECT used_at IS NOT NULL FROM h), false) AS used, (SELECT conversation_id FROM h) AS used_by,
            EXISTS (SELECT FROM member) AS is_member, EXISTS (SELECT FROM support_conversations WHERE id = ${conversationId}) AS taken
          FROM (SELECT 1) one LEFT JOIN c ON true`);
        return row!;
      });
      if (result.id) return c.json(view(result, true), 201);
      if (!result.handoff) throw new ApiError(404, 'NOT_FOUND', 'Handoff was not found for that user and workspace, or it expired.');
      if (result.used && result.used_by === conversationId) {
        const { rows: [again] } = await c.env.db.execute<Row>(sql`SELECT ${columns} FROM support_conversations WHERE id = ${conversationId}`);
        return c.json(view(again!, false), 200);
      }
      if (result.used) throw new ApiError(409, 'SUPPORT_HANDOFF_USED', 'This handoff already opened support access. The customer can contact support again for a new one.');
      if (result.taken) throw new ApiError(409, 'SUPPORT_CONVERSATION_EXISTS', 'That conversation is already registered with other evidence.');
      if (!result.is_member) throw new ApiError(404, 'NOT_FOUND', 'That person is no longer a member of the handoff’s workspace.');
      throw limitReached('chat');
    }

    const addressIds = c.env.config.support?.addressIds ?? [];
    if (!addressIds.length) throw new ApiError(404, 'SUPPORT_NOT_CONFIGURED', 'Email support is not set up here: set NIGHTMAIL_SUPPORT_ADDRESS_IDS to the support addresses.');
    const evidence = await emailEvidence(c.env.db, addressIds, body.evidence.messageId);
    if (!evidence) throw new ApiError(404, 'NOT_FOUND', 'Message was not found at a support address.');
    const messageId = body.evidence.messageId, details = { channel: 'email', message: messageId, dkimAligned: evidence.evidence.dkimAligned };
    const full = async (tx: DbExecutor, userId: string) => (await tx.execute<{ n: number }>(sql`SELECT ${openCount(userId, 'email')} AS n`)).rows[0]!.n >= OPEN_EMAIL_CONVERSATIONS;
    const outcome = await c.env.db.transaction(async tx => {
      let found = evidence;
      if (found.userId) {
        await admit(tx, found.userId);
        // A Message-ID binds its account once (under the person's lock): another delivery of the same email is answered
        // only after a sign-in. Kept only if this registration commits.
        await tx.execute(sql`INSERT INTO support_email_bindings(user_id, rfc_message_id, message_id) VALUES (${found.userId}, ${found.rfcMessageId}, ${messageId}) ON CONFLICT DO NOTHING`);
        const { rows: [first] } = await tx.execute<{ message_id: string }>(sql`SELECT message_id FROM support_email_bindings WHERE user_id = ${found.userId} AND rfc_message_id = ${found.rfcMessageId}`);
        if (first?.message_id !== messageId) found = replayed(found);
      }
      // A message that binds nobody is answered only once its sender confirms it signed in: recorded here, for the claim.
      const challenge = (tx: DbExecutor) => found.signIn ? tx.execute(sql`INSERT INTO support_email_signins(conversation_id, message_id, address, general_answer)
        VALUES (${conversationId}, ${messageId}, ${found.from}, ${found.generalAnswer}) ON CONFLICT DO NOTHING`) : null;
      const { rows: [existing] } = await tx.execute<Row>(sql`SELECT ${columns} FROM support_conversations WHERE id = ${conversationId} FOR UPDATE`);
      if (!existing) {
        if (found.userId && await full(tx, found.userId)) throw limitReached('email');
        const { rows: [row] } = await tx.execute<Row>(sql`WITH c AS (
            INSERT INTO support_conversations(id, channel, thread_id, user_id, pending_address, verification, evidence, mode)
            VALUES (${conversationId}, 'email', ${found.threadId}, ${found.userId}, ${found.from}, ${found.verification}, ${JSON.stringify(found.evidence)}::jsonb, ${found.mode}) RETURNING ${columns}
          ), logged AS (${audit(sql`c`, details)}) SELECT * FROM c`);
        await challenge(tx);
        return { row: row!, created: true, generalAnswer: found.generalAnswer };
      }
      if (existing.channel !== 'email') throw new ApiError(409, 'SUPPORT_CONVERSATION_EXISTS', 'That conversation is a chat, not an email conversation.');
      if (existing.status === 'closed') throw new ApiError(409, 'SUPPORT_CONVERSATION_CLOSED', 'That conversation is closed. Give the message a conversation of its own.');
      // One sender per conversation: another sender gets a conversation of its own. A bound conversation takes only mail
      // that binds the same account again: anything else (a message that doesn't verify, another account now holding the
      // address) gets a conversation of its own, and a bound conversation is never rebound or downgraded.
      if (existing.pending_address !== found.from) throw new ApiError(409, 'SUPPORT_CONVERSATION_SENDER', 'This message is from another sender. Give it a conversation of its own.');
      if (existing.user_id) {
        if (found.userId !== existing.user_id) throw new ApiError(409, 'SUPPORT_CONVERSATION_MISMATCH', 'This message does not bind the conversation’s account. Give it a conversation of its own.');
        return { row: existing, created: false, generalAnswer: found.generalAnswer };
      }
      // Unbound so far: each message is judged on its own, and one that binds its sender's account binds the conversation.
      if (found.userId && await full(tx, found.userId)) throw limitReached('email');
      const { rows: [row] } = await tx.execute<Row>(sql`WITH c AS (
          UPDATE support_conversations SET user_id = ${found.userId}, verification = ${found.verification}, mode = ${found.mode}, evidence = ${JSON.stringify(found.evidence)}::jsonb
          WHERE id = ${conversationId} RETURNING ${columns}
        ), logged AS (${audit(sql`c`, details)}) SELECT * FROM c`);
      await challenge(tx);
      return { row: row!, created: false, generalAnswer: found.generalAnswer };
    });
    log('info', { code: 'SUPPORT_CONVERSATION_REGISTERED', conversationId, channel: 'email', mode: outcome.row.mode, details });
    return c.json(view(outcome.row, outcome.created, outcome.generalAnswer), outcome.created ? 201 : 200);
  });

  app.openapi(createRoute({ hide: true, tags: ['Operator'], security: operatorSecurity, method: 'post', path: '/v1/operator/support/conversations/{id}/close', operationId: 'operatorCloseSupportConversation',
    description: 'The support platform ends a conversation (the binding only): every later request for it is refused. Repeating it is harmless.',
    request: { params: ConversationParam }, responses: { 200: response(z.object({ id: z.string(), status: z.literal('closed'), closedAt: z.string() })), ...errors } }), async c => {
    await supportPlatformOnly(c);
    const { rows: [row] } = await c.env.db.execute<{ id: string; closed_at: string }>(sql`UPDATE support_conversations SET status = 'closed', closed_at = coalesce(closed_at, now())
      WHERE id = ${c.req.valid('param').id} RETURNING id, closed_at::text`);
    if (!row) notFound('Support conversation');
    return c.json({ id: row!.id, status: 'closed' as const, closedAt: new Date(row!.closed_at).toISOString() }, 200);
  });

  const Released = z.object({ conversationId: z.string(), messageId: z.string(), requestedAt: z.string() }).openapi('SupportGeneralAnswerDue');
  const Filed = z.object({
    id: z.string(), status: z.enum(['open', 'ticketed', 'closed']),
    filed: z.boolean().describe('Nightmail opened this conversation from a filed message: the support platform has never registered it, and adopts it as a chat for this person and workspace.'),
    user: z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable() }),
    workspace: z.object({ id: z.string(), name: z.string(), role: z.enum(['owner', 'admin', 'member']) }).nullable().describe('The chat\u2019s workspace, while the person is still a member there; null otherwise (then it is not theirs to continue).'),
    page: z.string().nullable().describe('The dashboard page of the handoff that opened it.'), requestIds: z.array(z.string()).describe('The failed requests that handoff named.'),
    messages: z.array(z.object({ id: z.string(), text: z.string(), at: z.string() })).describe('The customer\u2019s messages filed while the chat couldn\u2019t take them, oldest first: take each into the transcript under its own ID (the mirror then leaves it as it is), as already handed to staff (no turn for it).'),
  }).openapi('SupportFiledConversation');
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security: operatorSecurity, method: 'get', path: '/v1/operator/support/conversations/{id}/filed', operationId: 'operatorGetFiledSupportConversation',
    description: 'A chat conversation as Nightmail holds it, with the messages the dashboard filed while the support chat couldn\u2019t take them (the binding only): what the support platform needs to adopt a conversation it never registered (evidence.filed) and to take filed messages into one it holds. Only a chat with a person; 404 otherwise.',
    request: { params: ConversationParam }, responses: { 200: response(Filed), ...errors } }), async c => {
    await supportPlatformOnly(c);
    const { rows: [row] } = await c.env.db.execute<{ id: string; status: z.infer<typeof Filed>['status']; filed: boolean; user: z.infer<typeof Filed>['user']; workspace: z.infer<typeof Filed>['workspace'];
      page: string | null; request_ids: string[] | null; messages: z.infer<typeof Filed>['messages'] }>(sql`SELECT s.id, s.status, coalesce((s.evidence->>'filed')::boolean, false) AS filed,
        json_build_object('id', u.id, 'name', u.name, 'email', u.email) AS user,
        (SELECT json_build_object('id', w.id, 'name', w.name, 'role', m.role) FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = s.user_id AND m.workspace_id = s.workspace_id) AS workspace,
        h.page, h.request_ids,
        coalesce((SELECT json_agg(json_build_object('id', f.id, 'text', f.text, 'at', to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY f.seq)
          FROM support_messages f WHERE f.conversation_id = s.id AND f.author = 'customer' AND f.kind = 'filed'), '[]') AS messages
      FROM support_conversations s JOIN nightmail_users u ON u.id = s.user_id
      LEFT JOIN LATERAL (SELECT page, request_ids FROM support_handoffs WHERE conversation_id = s.id ORDER BY created_at LIMIT 1) h ON true
      WHERE s.id = ${c.req.valid('param').id} AND s.channel = 'chat'`);
    if (!row) notFound('Support conversation');
    return c.json({ id: row!.id, status: row!.status, filed: row!.filed, user: row!.user, workspace: row!.workspace, page: row!.page, requestIds: row!.request_ids ?? [], messages: row!.messages }, 200);
  });

  app.openapi(createRoute({ hide: true, tags: ['Operator'], security: operatorSecurity, method: 'get', path: '/v1/operator/support/general-answers', operationId: 'operatorSupportGeneralAnswersDue',
    description: 'The support platform\u2019s due list (the binding only): conversations whose sender asked, from the sign-in link, to be answered by email instead (releaseGeneralAnswer), still open and with nothing reaching them since, oldest first. Answer each in general, once, with no account access.',
    request: { query: z.object({ conversationId: z.string().regex(CONVERSATION_ID).optional().describe('Only this conversation\u2019s (after its wake).') }) },
    responses: { 200: response(z.object({ data: z.array(Released) })), ...errors } }), async c => {
    await supportPlatformOnly(c);
    const only = c.req.valid('query').conversationId ?? null, { reached } = await import('./support-inbox.js');
    const { rows } = await c.env.db.execute<{ conversation_id: string; message_id: string; requested_at: string }>(sql`SELECT si.conversation_id, si.message_id, si.general_answer_requested_at::text AS requested_at
      FROM support_email_signins si JOIN support_conversations s ON s.id = si.conversation_id
      WHERE si.general_answer_requested_at > now() - ${RELEASE_DUE} AND s.status <> 'closed' AND (${only}::text IS NULL OR si.conversation_id = ${only})
        AND NOT EXISTS (SELECT FROM support_messages o WHERE o.conversation_id = s.id AND o.created_at > si.general_answer_requested_at AND ${reached})
      ORDER BY si.general_answer_requested_at, si.conversation_id LIMIT 50`);
    return c.json({ data: rows.map(r => ({ conversationId: r.conversation_id, messageId: r.message_id, requestedAt: new Date(r.requested_at).toISOString() })) }, 200);
  });

  // ---------- the customer's own session ----------
  const CurrentConversation = z.object({
    conversation: z.object({
      id: z.string(),
      status: z.enum(['open', 'ticketed']),
      createdAt: z.string(),
      lastMessageAt: z.string().nullable(),
    }).nullable(),
  }).openapi('CurrentSupportConversation');
  app.openapi(createRoute({ hide: true, tags: ['Workspaces'], security: sessionSecurity, method: 'get', path: '/v1/support-conversations/current', operationId: 'getCurrentSupportConversation',
    description: 'The signed-in person’s open support chat conversation for the current workspace, or null when none is open.',
    responses: { 200: response(CurrentConversation), ...errors } }), async c => {
    if (c.env.platformCaller) throw denied('DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.', { credential: 'dashboard' });
    const { userId, workspaceId } = dashboardSession(c);
    const { rows: [row] } = await c.env.db.execute<{ id: string; status: 'open' | 'ticketed'; created_at: string; last_message_at: string | null }>(sql`SELECT id, status, created_at::text AS created_at, last_message_at::text AS last_message_at
      FROM support_conversations
      WHERE channel = 'chat' AND user_id = ${userId} AND workspace_id = ${workspaceId} AND status <> 'closed'
      ORDER BY coalesce(last_message_at, created_at) DESC, created_at DESC, id DESC LIMIT 1`);
    c.header('Cache-Control', 'no-store');
    return c.json({ conversation: row ? { id: row.id, status: row.status, createdAt: new Date(row.created_at).toISOString(), lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null } : null }, 200);
  });
  const Claimed = z.object({ id: z.string(), messageId: z.string(), mode: Mode });
  const Pending = z.object({ id: z.string(), messageId: z.string(), subject: z.string().nullable().describe('The email’s subject as it arrived (untrusted text), so the person can tell which email they confirm.'),
    preview: z.string().nullable().describe('Plain-text excerpt of the email body (untrusted text), so the person can review what they are confirming.'),
    receivedAt: z.string().nullable().describe('When support received it.') });
  const MessageQuery = z.object({ messageId: z.string().regex(/^msg_[0-9a-f]{32}$/).describe('The email the sign-in link was for.') });
  app.openapi(createRoute({ hide: true, tags: ['Workspaces'], security: sessionSecurity, method: 'get', path: '/v1/support-conversations/{id}/claim', operationId: 'getSupportConversationClaim',
    description: `The email a sign-in link is for, before you confirm it (its subject, a plain-text excerpt and when it arrived), with the same checks as confirming it: only the person whose verified email sent it. Anyone else gets 404. A session whose sign-in proves no mailbox gets 403 MAILBOX_SIGN_IN_REQUIRED (not retryable), and while the email waits, error.details[0] holds address (masked) and nextStep: sendSupportSignInLink.`,
    request: { params: ConversationParam, query: MessageQuery }, responses: { 200: response(Pending), ...errors } }), async c => {
    if (!c.env.config.multiTenant) return notFound('Endpoint');
    if (c.env.platformCaller) throw denied('DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.', { credential: 'dashboard' });
    // Reads like reviewing an invitation: the session's sign-in must prove the account's address (no Origin on a GET).
    const { verifiedDashboardUser } = await import('./dashboard-auth.js');
    const conversationId = c.req.valid('param').id, messageId = c.req.valid('query').messageId;
    const user = await verifiedDashboardUser(c.env, c.req.raw.headers, true).catch(async error => { throw await mailboxStep(c, error, conversationId, messageId); });
    const target = await signinFor(c.env.db, conversationId, messageId, user, false);
    if (!target) return notFound('Support conversation');
    const preview = target.text ? target.text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || null : null;
    c.header('Cache-Control', 'no-store');
    return c.json({ id: conversationId, messageId, subject: target.subject?.slice(0, 200) ?? null, preview, receivedAt: target.received_at ? new Date(target.received_at).toISOString() : null }, 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Workspaces'], security: sessionSecurity, method: 'post', path: '/v1/support-conversations/{id}/claim', operationId: 'claimSupportConversation',
    description: `Confirm, signed in, that you wrote one email ${productName} support couldn’t verify: when your verified email is the address it came from, support answers that email from your account, once (when it already sent a general answer, only what needed your account), and the conversation is yours. Anyone else gets 404. A session whose sign-in proves no mailbox gets 403 MAILBOX_SIGN_IN_REQUIRED with the same details as getSupportConversationClaim.`,
    request: { params: ConversationParam, body: json(z.object({ messageId: z.string().regex(/^msg_[0-9a-f]{32}$/).describe('The email the sign-in link was for.') }).strict()) },
    responses: { 200: response(Claimed), ...errors } }), async c => {
    if (!c.env.config.multiTenant) return notFound('Endpoint');
    // Like accepting an invitation: a signed-in person whose session's verified email is still theirs, with or without a
    // workspace, from the dashboard's own origin. Never a bearer credential (refused inside) or the support platform.
    if (c.env.platformCaller) throw denied('DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.', { credential: 'dashboard' });
    const { invitationRecipient } = await import('./dashboard-auth.js');
    const conversationId = c.req.valid('param').id, messageId = c.req.valid('json').messageId;
    const user = await invitationRecipient(c.env, c.req.raw).catch(async error => { throw await mailboxStep(c, error, conversationId, messageId); }), userId = user.userId;
    const context = { ...auditContext(c), actor: { type: 'member' as const, id: userId, userId, via: 'dashboard' as const } };
    const claimed = await c.env.db.transaction(async tx => {
      await admit(tx, userId);
      // This one message's sign-in, for its sender only (signinFor). The rows are locked, so a race has one winner.
      const target = await signinFor(tx, conversationId, messageId, user, true);
      if (!target) return null;
      let mode = target.mode;
      if (!target.user_id) {
        if ((await tx.execute<{ n: number }>(sql`SELECT ${openCount(userId, 'email')} AS n`)).rows[0]!.n >= OPEN_EMAIL_CONVERSATIONS) throw limitReached('email');
        const { rows: [bound] } = await tx.execute<{ mode: z.infer<typeof Mode> }>(sql`UPDATE support_conversations SET user_id = ${userId}, verification = 'signin',
            mode = CASE WHEN EXISTS (SELECT FROM workspace_members WHERE user_id = ${userId}) THEN 'member' ELSE 'non_member' END, evidence = evidence || jsonb_build_object('claimedAt', now())
          WHERE id = ${conversationId} RETURNING mode`);
        mode = bound!.mode;
      } else await tx.execute(sql`UPDATE support_conversations SET evidence = evidence || jsonb_build_object('claimedAt', now()) WHERE id = ${conversationId}`);
      if (target.first) {
        await tx.execute(sql`UPDATE support_email_signins SET user_id = ${userId}, signed_in_at = clock_timestamp() WHERE conversation_id = ${conversationId} AND message_id = ${messageId}`);
        await recordAudit(tx, context, { action: 'support.claim', workspaceId: null, target: { type: 'support_conversation', id: conversationId }, details: { message: messageId }, ticketRef: conversationId, internal: true });
      }
      return { id: conversationId, messageId, mode };
    });
    if (!claimed) return notFound('Support conversation');
    // The support platform answers that message once it reads the sign-in in the scope: wake it with the ID only (again
    // on a repeated claim, which recovers a lost wake; its sweep asks again too). Nobody else's claim wakes anything.
    const { wakeSupport } = await import('./support-inbox.js');
    if (c.env.deferNudge) c.env.deferNudge(async () => { await wakeSupport(c.env.config, conversationId); });
    else await wakeSupport(c.env.config, conversationId);
    return c.json(claimed, 200);
  });

  const LinkRequested = z.object({ requested: z.literal(true), address: z.string().describe('Where the link goes, as getSupportConversationClaim’s 403 shows it.') });
  app.openapi(createRoute({ hide: true, tags: ['Workspaces'], security: sessionSecurity, method: 'post', path: '/v1/support-conversations/{id}/sign-in-link', operationId: 'sendSupportSignInLink',
    description: `The way through 403 MAILBOX_SIGN_IN_REQUIRED on one email's Continue page: emails a sign-in link to the address that email came from (never another: the body names only the message, and anything else in it is ignored). Following the link and signing in with the account for that address proves its mailbox, and the page opens again to confirm the email. Signed in, from the dashboard. The answer is the same 202 whether or not a link went out (one is made and sent only when an account has that address; otherwise nothing is); at most ${SUPPORT_LINKS.perConversation} a day per conversation and ${SUPPORT_LINKS.perAddress} per address, and as many as pending sign-ins per network, past which it is 429. Presses from the account the link would be for (signed in to it with a sign-in that proves no mailbox, the person the email came from) neither count against those daily limits nor are refused by them, so a leaked Continue link can't use them up and lock that person out; everyone else's presses count the same whether or not an account has the address. An email that waits for nobody gets 404.`,
    request: { params: ConversationParam, body: json(z.object({ messageId: z.string().regex(/^msg_[0-9a-f]{32}$/).describe('The email the Continue page is for.') })) },
    responses: { 202: response(LinkRequested), ...errors } }), async c => {
    if (!c.env.config.multiTenant) return notFound('Endpoint');
    if (c.env.platformCaller) throw denied('DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.', { credential: 'dashboard' });
    // Someone signed in, with any sign-in (it is the one that can't confirm), from the dashboard's own origin, who holds
    // this email's link. Never a bearer credential.
    const [{ LINK_ANSWER_MS, requireDashboardOrigin, reserveAuthState }, { verifiedDashboardUser }] = await Promise.all([import('./account-login.js'), import('./dashboard-auth.js')]);
    requireDashboardOrigin(c.env, c.req.raw);
    const presser = await verifiedDashboardUser(c.env, c.req.raw.headers);
    // Every network's allowance of sign-in links (account-login.ts /api/auth/sign-in/link), before anything is looked up.
    await reserveAuthState(c.env.db, await digest(`signin-link:${c.req.header(clientIpHeader) ?? 'unknown'}`));
    const conversationId = c.req.valid('param').id, messageId = c.req.valid('json').messageId, answerAt = Date.now() + LINK_ANSWER_MS;
    const { LINK_MINUTES, newLinkId } = await import('./signups.js'), { signinLink } = await import('./account-notices.js');
    const address = await c.env.db.transaction(async tx => {
      const { rows: [target] } = await tx.execute<{ address: string; user_id: string | null; signed_by: string | null }>(sql`SELECT si.address, s.user_id, si.user_id AS signed_by
        FROM support_conversations s JOIN support_email_signins si ON si.conversation_id = s.id AND si.message_id = ${messageId}
        WHERE s.id = ${conversationId} AND s.channel = 'email' AND s.status <> 'closed' AND si.created_at > now() - make_interval(days => ${SIGNIN_DAYS}::int)`);
      if (!target) return null;
      const email = target.address.toLowerCase();
      // The account a link is for (`u`): its verified address is this one and it can confirm this email (nobody else bound it).
      const forAccount = sql`u.email_verified AND lower(u.email) = ${email} AND (${target.user_id}::text IS NULL OR u.id = ${target.user_id})
        AND (${target.signed_by}::text IS NULL OR u.id = ${target.signed_by})`;
      // One request per address at a time (the waitlist's links take the same lock), so both counts hold.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${email},46400))`);
      // That account's own presses, from a session that proves no mailbox, are the person the email came from asking: they
      // don't count against anyone else's, so someone holding a leaked link can't use up the day's links and lock them out,
      // and they have a daily allowance of their own per address (as many as the address's), so they never make unlimited
      // mail either. Every other press counts, whether or not a link is made, so a refusal never says whether an account has
      // the address (only the account itself is told apart, and it knows its own address).
      const { rows: [own] } = await tx.execute<{ is: boolean }>(sql`SELECT EXISTS (SELECT FROM nightmail_users u WHERE u.id = ${presser.userId} AND ${forAccount}) AS is`);
      if (own!.is) {
        const charged = await tx.execute(sql`INSERT INTO api_request_budgets AS b(workspace_id, key_id, window_start, used) VALUES ('global', ${`support-signin-own:${await digest(email)}`}, date_trunc('day', now()), 1)
          ON CONFLICT (workspace_id, key_id) DO UPDATE SET used = CASE WHEN b.window_start = excluded.window_start THEN b.used + 1 ELSE 1 END, window_start = excluded.window_start
          WHERE b.window_start <> excluded.window_start OR b.used < ${SUPPORT_LINKS.perAddress} RETURNING 1`);
        if (!charged.rowCount) throw new ApiError(429, 'SIGN_IN_LINK_LIMIT', 'Too many sign-in links were asked for today. Use one already sent, or try again tomorrow.');
      } else {
        const today = sql`link_window_at > now() - interval '1 day'`;
        const { rows: [asked] } = await tx.execute<{ conversation: number; address: number }>(sql`SELECT
          (SELECT coalesce(sum(link_requests), 0)::int FROM support_email_signins WHERE conversation_id = ${conversationId} AND ${today}) AS conversation,
          (SELECT coalesce(sum(link_requests), 0)::int FROM support_email_signins WHERE address = ${target.address} AND ${today}) AS address`);
        if (asked!.conversation >= SUPPORT_LINKS.perConversation || asked!.address >= SUPPORT_LINKS.perAddress)
          throw new ApiError(429, 'SIGN_IN_LINK_LIMIT', 'Too many sign-in links were asked for today. Use one already sent, or try again tomorrow.');
        await tx.execute(sql`UPDATE support_email_signins SET link_requests = CASE WHEN ${today} THEN link_requests + 1 ELSE 1 END,
          link_window_at = CASE WHEN ${today} THEN link_window_at ELSE now() END WHERE conversation_id = ${conversationId} AND message_id = ${messageId}`);
      }
      // A link, and its email, only for that account: a link to anyone else would prove nothing. Otherwise nothing is made or
      // sent, and the answer is the same.
      const workspaceId = c.env.config.platformDomainWorkspace, id = newLinkId();
      const { rows: [link] } = workspaceId ? await tx.execute<{ id: string }>(sql`INSERT INTO nightmail_signin_links(id, email, conversation_id, message_id, expires_at)
        SELECT ${id}, ${email}, ${conversationId}, ${messageId}, now() + make_interval(mins => ${LINK_MINUTES}::int)
        WHERE EXISTS (SELECT FROM nightmail_users u WHERE ${forAccount})
        RETURNING id`) : { rows: [] };
      if (link) await tx.execute(signinLink(workspaceId!, link.id));
      return target.address;
    });
    if (!address) return notFound('Support conversation');
    log('info', { code: 'SUPPORT_SIGNIN_LINK_REQUESTED', conversationId });
    // A link and its email take a few writes more than none: the answer waits until a fixed time after the request.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, answerAt - Date.now())));
    c.header('Cache-Control', 'no-store');
    return c.json({ requested: true as const, address: await shownAddress(c, address) }, 202);
  });

  const AnsweredByEmail = z.object({
    outcome: z.enum(['released', 'already_released', 'answered', 'already_answered']).describe('released: support answers by email now; already_released: it was asked before and the answer hasn\u2019t gone yet, nothing new; answered: it was asked before and the answer has gone since, nothing new; already_answered: support answered that email before anyone asked, nothing new.'),
    address: z.string().describe('Where the answer goes: the address the email came from, as getSupportConversationClaim’s 403 shows it.'),
  });
  app.openapi(createRoute({ hide: true, tags: ['Workspaces'], security: [], method: 'post', path: '/v1/support-conversations/{id}/answer-by-email', operationId: 'answerSupportConversationByEmail',
    description: `"Answer me by email instead", on one email's Continue page: whoever holds the link support emailed to the conversation's address (its conversation and message IDs) asks to be answered by email, signed in as anyone or not at all, from the dashboard. Support then answers in general, with no account access, at the stored address in the same thread, once per conversation (releaseGeneralAnswer). Nothing is attached to any account and nothing of the email is shown; the body names only the message, and anything else in it is ignored. Never on GET. The answer comes at a fixed time and is the same whatever account the address has; an email that isn't waiting (unknown, claimed, closed, or older than ${SIGNIN_DAYS} days) gets 404. At most ${ANSWER_SLOTS} requests per conversation and per network in 11 minutes, past which 429 ANSWER_BY_EMAIL_LIMIT.`,
    request: { params: ConversationParam, body: json(z.object({ messageId: z.string().regex(/^msg_[0-9a-f]{32}$/).describe('The email the Continue page is for.') })) },
    responses: { 200: response(AnsweredByEmail), ...errors } }), async c => {
    if (!c.env.config.multiTenant) return notFound('Endpoint');
    if (c.env.platformCaller) throw denied('DASHBOARD_AUTH_REQUIRED', 'Use the dashboard.', { credential: 'dashboard' });
    const [{ LINK_ANSWER_MS, requireDashboardOrigin }, { wakeSupport }] = await Promise.all([import('./account-login.js'), import('./support-inbox.js')]);
    requireDashboardOrigin(c.env, c.req.raw);
    const conversationId = c.req.valid('param').id, messageId = c.req.valid('json').messageId, answerAt = Date.now() + LINK_ANSWER_MS;
    // Per network and per conversation (as many as pending sign-ins, in 11 minutes), before anything is looked up.
    for (const peer of [`answer-by-email:${c.req.header(clientIpHeader) ?? 'unknown'}`, `answer-by-email:${conversationId}`]) {
      const { rows: [slot] } = await c.env.db.execute<{ ok: boolean }>(sql`SELECT reserve_auth_state(${await digest(peer)}) AS ok`);
      if (!slot?.ok) throw new ApiError(429, 'ANSWER_BY_EMAIL_LIMIT', 'Too many requests to answer by email. Try again in a few minutes.');
    }
    // Nobody is acting as a person here: the trail names the request, internal, with no person.
    const context = { ...auditContext(c), actor: { type: 'system' as const, id: null, via: 'dashboard' as const, label: 'Answer me by email instead' } };
    const answered = await c.env.db.transaction(async tx => {
      let outcome: GeneralAnswerRelease | 'answered' = await releaseGeneralAnswer(tx, conversationId, messageId);
      if (outcome === 'not_waiting') return null;
      // Asked before: whether the answer has actually gone out since (an agent's answer or a staff reply, sent; not a held
      // draft, a queued reply or a notice). The presser holds the link mailed to that address, where it went.
      if (outcome === 'already_released') {
        const { rows: [since] } = await tx.execute<{ went: boolean }>(sql`SELECT EXISTS (SELECT FROM support_messages o WHERE o.conversation_id = ${conversationId}
            AND o.author IN ('agent', 'staff') AND o.kind IS DISTINCT FROM 'held' AND o.delivery = 'sent'
            AND o.created_at > (SELECT min(r.general_answer_requested_at) FROM support_email_signins r WHERE r.conversation_id = ${conversationId})) AS went`);
        if (since!.went) outcome = 'answered';
      }
      const { rows: [row] } = await tx.execute<{ address: string }>(sql`SELECT address FROM support_email_signins WHERE conversation_id = ${conversationId} AND message_id = ${messageId}`);
      // A trail row needs a workspace or a person: it is the support address's workspace's (Nightmail's own), internal.
      if (outcome === 'released') await tx.execute(auditInsert(context, { action: 'support.answer_by_email', workspaceId: sql`w.id`, target: { type: 'support_conversation', id: conversationId }, details: { message: messageId }, ticketRef: conversationId, internal: true },
        { from: sql`(SELECT coalesce((SELECT t.workspace_id FROM support_conversations s JOIN mail_threads t ON t.id = s.thread_id WHERE s.id = ${conversationId}), ${c.env.config.platformDomainWorkspace ?? null}::text) AS id) w`, where: sql`w.id IS NOT NULL` }));
      return { outcome, address: row!.address };
    });
    await new Promise(resolve => setTimeout(resolve, Math.max(0, answerAt - Date.now())));
    if (!answered) return notFound('Support conversation');
    // Committed: wake the support platform with the conversation's ID, as a claim does (its sweep finds the release anyway).
    if (answered.outcome === 'released') {
      if (c.env.deferNudge) c.env.deferNudge(async () => { await wakeSupport(c.env.config, conversationId); });
      else await wakeSupport(c.env.config, conversationId);
    }
    log('info', { code: 'SUPPORT_ANSWER_BY_EMAIL', conversationId, outcome: answered.outcome });
    c.header('Cache-Control', 'no-store');
    return c.json({ outcome: answered.outcome, address: await shownAddress(c, answered.address) }, 200);
  });

  app.openapi(createRoute({ hide: true, tags: ['Workspaces'], security: sessionSecurity, method: 'post', path: '/v1/support-conversations/{id}/content-access', operationId: 'shareSupportConversationContent',
    description: `Let ${productName} support read message content (email bodies) in your support chat’s workspace, for that chat only. Only the person the chat is for, while a member there.`,
    request: { params: ConversationParam }, responses: { 200: response(z.object({ id: z.string(), contentWorkspaceId: z.string() })), ...errors } }), async c => {
    const { userId } = dashboardSession(c), conversationId = c.req.valid('param').id;
    const { rows: [row] } = await c.env.db.execute<{ id: string; workspace_id: string }>(sql`WITH shared AS (
        UPDATE support_conversations s SET content_workspace_id = s.workspace_id
        WHERE s.id = ${conversationId} AND s.channel = 'chat' AND s.status <> 'closed' AND s.user_id = ${userId}
          AND EXISTS (SELECT FROM workspace_members m WHERE m.user_id = s.user_id AND m.workspace_id = s.workspace_id)
        RETURNING s.id, s.workspace_id
      ), logged AS (${auditInsert(auditContext(c), { action: 'support.content', workspaceId: sql`shared.workspace_id`, target: { type: 'support_conversation', id: conversationId }, ticketRef: conversationId, internal: true },
        { from: sql`shared` })})
      SELECT id, workspace_id FROM shared`);
    if (!row) notFound('Support conversation');
    return c.json({ id: row!.id, contentWorkspaceId: row!.workspace_id }, 200);
  });

  // ---------- stamped: the conversation's own scope (supportGate has checked and logged the call) ----------
  const Workspace = z.object({ id: z.string(), name: z.string(), role: z.enum(['owner', 'admin', 'member']) });
  const Scope = z.object({
    conversation: z.object({ id: z.string(), channel: z.enum(['chat', 'email']), mode: Mode, verification: z.enum(['handoff', 'dmarc', 'signin', 'none', 'agent']),
      signedIn: z.array(z.string()).describe('The messages of an email conversation its person confirmed, signed in (the claim), oldest first: each is answered once. Empty otherwise.') }),
    user: z.object({ id: z.string().nullable().describe('The person the conversation is bound to, as Nightmail stamps it; null when nobody is.'), name: z.string().nullable(), email: z.string().nullable(),
      mailboxProven: z.boolean().describe('Whether email is the account’s verified address and a sign-in proved it a mailbox the person reads within the proof window. Only then may an answer written from the account go to it, and only to email as stored.'),
      activeSession: z.boolean().describe('Whether this person currently has an active dashboard session.'),
      sessionSince: z.string().nullable().describe('Earliest start time of this person’s active dashboard sessions, or null when signed out.') }),
    workspace: Workspace.nullable().describe('The one workspace in scope (a chat’s, or the one an email narrowed to), while the person is still a member there; null otherwise.'),
    workspaces: z.array(Workspace).describe('What the conversation can read or choose now: a chat’s one workspace, or every workspace an email’s sender belongs to.'),
    contentWorkspaceId: z.string().nullable().describe('Where the customer let support read message content, while still a member there; null otherwise.'),
    page: z.string().nullable().describe('The dashboard page a chat was opened from.'),
    shrunk: z.boolean().describe('True once the person lost a workspace this conversation read: end the conversation without restating what was read.'),
  }).openapi('SupportScope');
  const tags = ['Support (internal)'], security: Record<string, string[]>[] = [{ bearerAuth: [] }];
  const describe = (text: string) => `${text} Internal: for ${productName} support, for one support conversation, never for customers.`;
  const conversationOf = (c: Ctx) => {
    const conversation = c.get('support')?.conversation;
    if (!conversation) throw new ApiError(403, 'SUPPORT_CONVERSATION_REQUIRED', 'Only a support conversation has a scope.');
    return { ...conversation, userId: c.get('support')!.userId };
  };
  async function scopeOf(db: DbExecutor, conversationId: string) {
    const { rows: [row] } = await db.execute<z.infer<typeof Scope> & { workspace_id: string | null }>(sql`WITH s AS (SELECT * FROM support_conversations WHERE id = ${conversationId}),
      memberships AS (SELECT w.id, w.name, m.role FROM s JOIN workspace_members m ON m.user_id = s.user_id JOIN workspaces w ON w.id = m.workspace_id)
      SELECT json_build_object('id', s.id, 'channel', s.channel, 'mode', s.mode, 'verification', s.verification,
          'signedIn', coalesce((SELECT json_agg(si.message_id ORDER BY si.signed_in_at, si.message_id) FROM support_email_signins si WHERE si.conversation_id = s.id AND si.user_id = s.user_id), '[]')) AS conversation,
        (SELECT json_build_object('id', u.id, 'name', u.name, 'email', u.email, 'mailboxProven', ${mailboxProven(sql`u`)},
          'activeSession', EXISTS (SELECT FROM nightmail_sessions ns WHERE ns.user_id = u.id AND ns.expires_at > now()),
          'sessionSince', (SELECT to_char((min(ns.expires_at) - interval '7 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM nightmail_sessions ns WHERE ns.user_id = u.id AND ns.expires_at > now())
        ) FROM nightmail_users u WHERE u.id = s.user_id) AS user,
        (SELECT json_build_object('id', id, 'name', name, 'role', role) FROM memberships WHERE id = s.workspace_id) AS workspace,
        coalesce((SELECT json_agg(json_build_object('id', id, 'name', name, 'role', role) ORDER BY name, id) FROM memberships WHERE s.workspace_id IS NULL OR s.channel = 'email' OR id = s.workspace_id), '[]') AS workspaces,
        (SELECT id FROM memberships WHERE id = s.content_workspace_id) AS "contentWorkspaceId",
        (SELECT page FROM support_handoffs WHERE conversation_id = s.id ORDER BY created_at LIMIT 1) AS page,
        EXISTS (SELECT FROM audit_events v WHERE v.action = 'support.view' AND v.actor_id = s.id AND v.workspace_id IS NOT NULL AND v.workspace_id NOT IN (SELECT id FROM memberships)) AS shrunk,
        s.workspace_id FROM s`);
    const { workspace_id: _w, ...scope } = row!;
    return { ...scope, user: scope.user ?? { id: null, name: null, email: null, mailboxProven: false, activeSession: false, sessionSince: null } };
  }
  app.openapi(createRoute({ hide: true, method: 'get', path: '/v1/support/scope', operationId: 'getSupportScope', tags, security, description: describe('Who this conversation is for and what it can read now: the person, the workspace in scope and their role there, content access, and whether they lost a workspace it read. Read it at the start of every turn.'),
    responses: { 200: response(Scope), ...errors } }), async c => c.json(await scopeOf(c.env.db, conversationOf(c).id), 200));
  app.openapi(createRoute({ hide: true, method: 'post', path: '/v1/support/scope', operationId: 'updateSupportScope', tags, security, description: describe('Narrow an email conversation to one of the sender’s workspaces, or switch to another of them. A chat stays in the workspace it came from.'),
    request: { body: json(z.object({ workspaceId: z.string().min(1).max(100) }).strict()) }, responses: { 200: response(Scope), ...errors } }), async c => {
    const conversation = conversationOf(c), workspaceId = c.req.valid('json').workspaceId;
    if (conversation.channel === 'chat' && workspaceId !== conversation.workspaceId) throw new ApiError(409, 'SUPPORT_SCOPE_FIXED', 'A chat stays in the workspace the customer contacted support from.', 'workspaceId');
    const { rows } = await c.env.db.execute(sql`UPDATE support_conversations s SET workspace_id = ${workspaceId}
      WHERE s.id = ${conversation.id} AND EXISTS (SELECT FROM workspace_members m WHERE m.user_id = s.user_id AND m.workspace_id = ${workspaceId}) RETURNING s.id`);
    if (!rows.length) notFound('Workspace');
    return c.json(await scopeOf(c.env.db, conversation.id), 200);
  });
}
