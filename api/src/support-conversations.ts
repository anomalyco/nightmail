import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { ApiError, dashboardSession, denied, errors, json, log, notFound, response, type App, type Ctx, type DbExecutor } from './core.js';
import { auditContext, auditInsert, operatorContext, recordAudit, requireOperator } from './audit.js';
import { CONVERSATION_ID, verifyHandoffToken, type RegisteredConversation } from './support-platform.js';
import type { MailHeader, Verdicts } from './db/mailbox.js';
import { productName } from './brand.js';
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
 * customer-visible "support viewed" row. `chatOnly`: an email conversation is refused (it proposes nothing and keeps no notes).
 */
export const SUPPORT_CEILINGS: Ceiling[] = [
  // Its domains, webhook failures and activity follow their own counterparts (CONTEXT_SECTIONS).
  { method: 'GET', path: '/v1/support/context', roles: EVERYONE, counterpart: 'GET /v1/workspaces' },
  { method: 'GET', path: '/v1/support/workspaces', roles: EVERYONE, counterpart: 'GET /v1/workspaces' },
  { method: 'GET', path: '/v1/support/domains', roles: MANAGERS, counterpart: 'GET /v1/domains' },
  // Received mail follows actorMailAccess: a member reads mail on receiving addresses only, not unassigned stored mail.
  { method: 'GET', path: '/v1/support/emails', roles: EVERYONE, counterpart: 'GET /v1/emails' },
  { method: 'GET', path: '/v1/support/emails/{id}', roles: EVERYONE, counterpart: 'GET /v1/emails' },
  { method: 'GET', path: '/v1/support/events', roles: EVERYONE, counterpart: 'GET /v1/emails' },
  { method: 'GET', path: '/v1/support/webhook-deliveries', roles: MANAGERS, counterpart: 'GET /v1/webhooks' },
  { method: 'GET', path: '/v1/support/standing', roles: EVERYONE, counterpart: 'GET /v1/sender-score' },
  { method: 'GET', path: '/v1/support/billing', roles: MANAGERS, counterpart: 'GET /v1/billing/ledger' },
  { method: 'GET', path: '/v1/support/audit', roles: MANAGERS, counterpart: 'GET /v1/activity' },
  // Request lines and traces show the whole workspace's API activity and its audit entries.
  { method: 'GET', path: '/v1/support/requests', roles: MANAGERS, counterpart: 'GET /v1/activity' },
  { method: 'GET', path: '/v1/support/requests/{requestId}', roles: MANAGERS, counterpart: 'GET /v1/activity' },
  { method: 'GET', path: '/v1/support/deliverability/metrics', roles: EVERYONE, counterpart: 'GET /v1/metrics' },
  { method: 'GET', path: '/v1/support/deliverability/bounces', roles: EVERYONE, counterpart: 'GET /v1/metrics' },
  { method: 'GET', path: '/v1/support/domains/{id}/health', roles: MANAGERS, counterpart: 'GET /v1/domains' },
  // Actions (src/support-actions.ts): every kind's public route, and the domain re-check's, needs an owner or admin.
  { method: 'POST', path: '/v1/support/actions', roles: MANAGERS, counterpart: 'GET /v1/webhooks', chatOnly: true },
  { method: 'GET', path: '/v1/support/actions/{id}', roles: MANAGERS, counterpart: 'GET /v1/webhooks', chatOnly: true },
  { method: 'POST', path: '/v1/support/domains/{id}/verify', roles: MANAGERS, counterpart: 'GET /v1/domains', chatOnly: true },
  { method: 'GET', path: '/v1/support/screen', roles: EVERYONE, counterpart: 'GET /v1/emails' },
  { method: 'GET', path: '/v1/support/campaigns', roles: EVERYONE, counterpart: 'GET /v1/campaigns' },
  { method: 'GET', path: '/v1/support/campaigns/{id}', roles: EVERYONE, counterpart: 'GET /v1/campaigns' },
  { method: 'GET', path: '/v1/support/emails/{id}/lint', roles: EVERYONE, counterpart: 'GET /v1/emails' },
  { method: 'GET', path: '/v1/support/campaigns/{id}/lint', roles: EVERYONE, counterpart: 'GET /v1/campaigns' },
  { method: 'GET', path: '/v1/support/audience/health', roles: EVERYONE, counterpart: 'GET /v1/lists' },
  { method: 'GET', path: '/v1/support/scope', roles: EVERYONE, counterpart: 'GET /v1/workspaces', views: false },
  { method: 'POST', path: '/v1/support/scope', roles: EVERYONE, counterpart: 'GET /v1/workspaces', views: false },
  // Notes are the person's own (src/support-notes.ts), filtered by their memberships, never a workspace's data.
  { method: 'GET', path: '/v1/support/notes', roles: EVERYONE, counterpart: 'GET /v1/workspaces', views: false, chatOnly: true },
  { method: 'POST', path: '/v1/support/notes', roles: EVERYONE, counterpart: 'GET /v1/workspaces', views: false, chatOnly: true },
];
/** The parts of GET /v1/support/context that follow another counterpart than the route's own. */
export const CONTEXT_SECTIONS = {
  domains: { roles: MANAGERS, counterpart: 'GET /v1/domains' },
  webhookDeliveries: { roles: MANAGERS, counterpart: 'GET /v1/webhooks' },
  recentActivity: { roles: MANAGERS, counterpart: 'GET /v1/activity' },
} as const;
const compiled = SUPPORT_CEILINGS.map(entry => ({ ...entry, pattern: new RegExp(`^${entry.path.replace(/\{[^}]+\}/g, '[^/]+')}$`) }));
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
  id: z.string(), channel: z.enum(['chat', 'email']), mode: Mode.describe('member: reads the account by role; non_member: general answers; pending_signin and unverified: the same fixed reply, no model turn.'),
  verification: z.enum(['handoff', 'dmarc', 'signin', 'none']), status: z.enum(['open', 'ticketed', 'closed']),
  workspaceId: z.string().nullable().describe('The one workspace in scope: a chat’s, or the one an email narrowed to. Null: every membership.'),
  contentShared: z.boolean().describe('Whether the customer let support read message content (a chat, in its own workspace).'),
  created: z.boolean().describe('False when this registration repeated or added to an earlier one.'),
}).openapi('SupportConversationRegistration');
type Row = { id: string; channel: 'chat' | 'email'; mode: z.infer<typeof Mode>; verification: RegisteredConversation['verification']; status: RegisteredConversation['status']; workspace_id: string | null;
  content_workspace_id: string | null; user_id: string | null; pending_address: string | null };
const view = (row: Row, created: boolean): RegisteredConversation => ({ id: row.id, channel: row.channel, mode: row.mode, verification: row.verification, status: row.status,
  workspaceId: row.workspace_id, contentShared: !!row.content_workspace_id, created });
const columns = sql`id, channel, mode, verification, status, workspace_id, content_workspace_id, user_id, pending_address`;
/** The support platform's service binding, and nothing else: an operator's own session gets 403 too. */
export const supportPlatformOnly = async (c: Ctx) => {
  const operator = await requireOperator(c, 'operator:read');
  if (operator.via !== 'support') throw new ApiError(403, 'SUPPORT_PLATFORM_REQUIRED', 'Only the support platform makes this call, through its service binding.');
  return operator;
};
const limitReached = (channel: 'chat' | 'email') => new ApiError(429, 'SUPPORT_CONVERSATION_LIMIT', channel === 'chat' ? `This person already has ${OPEN_CONVERSATIONS} open support chats. Close one first.`
  : `This person already has ${OPEN_EMAIL_CONVERSATIONS} open email support conversations. One must end first.`);
const openCount = (userId: unknown, channel: 'chat' | 'email') => sql`(SELECT count(*)::int FROM support_conversations WHERE user_id = ${userId} AND channel = ${channel} AND status <> 'closed')`;
/**
 * Serializes admission for one person: every path that sets user_id (a handoff, an email, a claim) takes this lock first, before
 * any conversation or handoff row, so its count is a later statement that sees every admission committed before it.
 */
const admit = (tx: DbExecutor, userId: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 39601))`);

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
 * The last two get the same fixed reply, with a sign-in for this message (`signIn`). dkimAligned records whether a sole
 * signature of the From domain passed too.
 */
async function emailEvidence(db: DbExecutor, addressIds: string[], messageId: string) {
  const { rows: [m] } = await db.execute<{ thread_id: string; from_address: string; verdicts: Verdicts; headers: MailHeader[]; author_verified: boolean | null; rfc_message_id: string | null;
    addressed: boolean; recent: boolean }>(sql`SELECT m.thread_id, m.from_address, m.verdicts, m.headers, m.message_id AS rfc_message_id, links.author_verified,
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
  // Verified addresses are unique in any case (account-login.ts), so at most one account can match.
  const { rows: owners } = await db.execute<{ id: string; email: string; memberships: number; proven: boolean }>(sql`SELECT u.id, u.email, ${mailboxProven(sql`u`)} AS proven,
      (SELECT count(*)::int FROM workspace_members wm WHERE wm.user_id = u.id) AS memberships
    FROM nightmail_users u WHERE u.email_verified AND lower(u.email) = ${from} LIMIT 2`);
  const owner = owners.length === 1 ? owners[0]! : null, exact = !!owner && sameMailbox(owner.email.trim(), written);
  const eligible = verified && exact && owner!.proven && addressed;
  const userId = eligible && owner!.memberships > 0 ? owner!.id : null;
  const mode: Row['mode'] = userId ? 'member' : verified && (!owner || eligible) ? 'non_member' : owners.length ? 'pending_signin' : 'unverified';
  return { from, threadId: m.thread_id, userId, mode, signIn: mode === 'pending_signin' || mode === 'unverified', verification: verified ? 'dmarc' as const : 'none' as const,
    rfcMessageId: m.rfc_message_id, evidence: { message: messageId, dmarc, dkimAligned, mailboxProven: !!owner?.proven, addressed } };
}
/** The same email again, for an account it already bound (a replay of a signed copy): it binds nobody, and asks for a sign-in. */
const replayed = (found: NonNullable<Awaited<ReturnType<typeof emailEvidence>>>) => ({ ...found, userId: null, mode: 'pending_signin' as Row['mode'], signIn: true, evidence: { ...found.evidence, replayed: true } });

/**
 * The sign-in one email waits for, as the person signed in may see or confirm it: the conversation an open email one with
 * nobody else bound to it, the sign-in recorded for that message within SIGNIN_DAYS and nobody else's, its address this
 * person's verified email (in any case), and that address a mailbox they proved (mailboxProven). Null for anyone else.
 */
async function signinFor(db: DbExecutor, conversationId: string, messageId: string, user: { userId: string; email: string }, lock: boolean) {
  const { rows: [target] } = await db.execute<{ user_id: string | null; mode: z.infer<typeof Mode>; address: string; signed_by: string | null; first: boolean; subject: string | null; received_at: string | null }>(sql`SELECT s.user_id, s.mode,
      si.address, si.user_id AS signed_by, si.signed_in_at IS NULL AS first, m.subject, m.received_at::text
    FROM support_conversations s JOIN support_email_signins si ON si.conversation_id = s.id AND si.message_id = ${messageId}
    JOIN nightmail_users u ON u.id = ${user.userId} AND ${mailboxProven(sql`u`)}
    LEFT JOIN mail_messages m ON m.id = si.message_id AND m.direction = 'inbound'
    WHERE s.id = ${conversationId} AND s.channel = 'email' AND s.status <> 'closed' AND si.created_at > now() - make_interval(days => ${SIGNIN_DAYS}::int)
    ${lock ? sql`FOR UPDATE OF s, si` : sql``}`);
  if (!target || target.address.toLowerCase() !== user.email.trim().toLowerCase() || (target.signed_by ?? user.userId) !== user.userId || (target.user_id ?? user.userId) !== user.userId) return null;
  return target;
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
      if (!checked.ok) throw checked.code === 'SUPPORT_NOT_CONFIGURED' ? new ApiError(503, 'SUPPORT_NOT_CONFIGURED', 'Set NIGHTMAIL_SUPPORT_SIGNING_KEY to sign and check handoffs.')
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
    if (!addressIds.length) throw new ApiError(503, 'SUPPORT_NOT_CONFIGURED', 'Set NIGHTMAIL_SUPPORT_ADDRESS_IDS to the support addresses before registering email conversations.');
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
      const challenge = (tx: DbExecutor) => found.signIn ? tx.execute(sql`INSERT INTO support_email_signins(conversation_id, message_id, address)
        VALUES (${conversationId}, ${messageId}, ${found.from}) ON CONFLICT DO NOTHING`) : null;
      const { rows: [existing] } = await tx.execute<Row>(sql`SELECT ${columns} FROM support_conversations WHERE id = ${conversationId} FOR UPDATE`);
      if (!existing) {
        if (found.userId && await full(tx, found.userId)) throw limitReached('email');
        const { rows: [row] } = await tx.execute<Row>(sql`WITH c AS (
            INSERT INTO support_conversations(id, channel, thread_id, user_id, pending_address, verification, evidence, mode)
            VALUES (${conversationId}, 'email', ${found.threadId}, ${found.userId}, ${found.from}, ${found.verification}, ${JSON.stringify(found.evidence)}::jsonb, ${found.mode}) RETURNING ${columns}
          ), logged AS (${audit(sql`c`, details)}) SELECT * FROM c`);
        await challenge(tx);
        return { row: row!, created: true };
      }
      if (existing.channel !== 'email') throw new ApiError(409, 'SUPPORT_CONVERSATION_EXISTS', 'That conversation is a chat, not an email conversation.');
      if (existing.status === 'closed') throw new ApiError(409, 'SUPPORT_CONVERSATION_CLOSED', 'That conversation is closed. Give the message a conversation of its own.');
      // One sender per conversation: another sender gets a conversation of its own. A bound conversation takes only mail
      // that binds the same account again: anything else (a message that doesn't verify, another account now holding the
      // address) gets a conversation of its own, and a bound conversation is never rebound or downgraded.
      if (existing.pending_address !== found.from) throw new ApiError(409, 'SUPPORT_CONVERSATION_SENDER', 'This message is from another sender. Give it a conversation of its own.');
      if (existing.user_id) {
        if (found.userId !== existing.user_id) throw new ApiError(409, 'SUPPORT_CONVERSATION_MISMATCH', 'This message does not bind the conversation’s account. Give it a conversation of its own.');
        return { row: existing, created: false };
      }
      // Unbound so far: each message is judged on its own, and one that binds its sender's account binds the conversation.
      if (found.userId && await full(tx, found.userId)) throw limitReached('email');
      const { rows: [row] } = await tx.execute<Row>(sql`WITH c AS (
          UPDATE support_conversations SET user_id = ${found.userId}, verification = ${found.verification}, mode = ${found.mode}, evidence = ${JSON.stringify(found.evidence)}::jsonb
          WHERE id = ${conversationId} RETURNING ${columns}
        ), logged AS (${audit(sql`c`, details)}) SELECT * FROM c`);
      await challenge(tx);
      return { row: row!, created: false };
    });
    log('info', { code: 'SUPPORT_CONVERSATION_REGISTERED', conversationId, channel: 'email', mode: outcome.row.mode, details });
    return c.json(view(outcome.row, outcome.created), outcome.created ? 201 : 200);
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

  // ---------- the customer's own session ----------
  const Claimed = z.object({ id: z.string(), messageId: z.string(), mode: Mode });
  const Pending = z.object({ id: z.string(), messageId: z.string(), subject: z.string().nullable().describe('The email’s subject as it arrived (untrusted text), so the person can tell which email they confirm. Never its body.'),
    receivedAt: z.string().nullable().describe('When support received it.') });
  const MessageQuery = z.object({ messageId: z.string().regex(/^msg_[0-9a-f]{32}$/).describe('The email the sign-in link was for.') });
  app.openapi(createRoute({ hide: true, tags: ['Workspaces'], security: sessionSecurity, method: 'get', path: '/v1/support-conversations/{id}/claim', operationId: 'getSupportConversationClaim',
    description: `The email a sign-in link is for, before you confirm it (its subject and when it arrived, never its content), with the same checks as confirming it: only the person whose verified email sent it. Anyone else gets 404.`,
    request: { params: ConversationParam, query: MessageQuery }, responses: { 200: response(Pending), ...errors } }), async c => {
    if (!c.env.config.multiTenant) return notFound('Endpoint');
    if (c.env.platformCaller) throw denied('DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.', { credential: 'dashboard' });
    // Reads like reviewing an invitation: the session's sign-in must prove the account's address (no Origin on a GET).
    const { verifiedDashboardUser } = await import('./dashboard-auth.js');
    const user = await verifiedDashboardUser(c.env, c.req.raw.headers, true);
    const conversationId = c.req.valid('param').id, messageId = c.req.valid('query').messageId;
    const target = await signinFor(c.env.db, conversationId, messageId, user, false);
    if (!target) return notFound('Support conversation');
    c.header('Cache-Control', 'no-store');
    return c.json({ id: conversationId, messageId, subject: target.subject?.slice(0, 200) ?? null, receivedAt: target.received_at ? new Date(target.received_at).toISOString() : null }, 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Workspaces'], security: sessionSecurity, method: 'post', path: '/v1/support-conversations/{id}/claim', operationId: 'claimSupportConversation',
    description: `Confirm, signed in, that you wrote one email ${productName} support couldn’t verify: when your verified email is the address it came from, support answers that email, once, and the conversation is yours. Anyone else gets 404.`,
    request: { params: ConversationParam, body: json(z.object({ messageId: z.string().regex(/^msg_[0-9a-f]{32}$/).describe('The email the sign-in link was for.') }).strict()) },
    responses: { 200: response(Claimed), ...errors } }), async c => {
    if (!c.env.config.multiTenant) return notFound('Endpoint');
    // Like accepting an invitation: a signed-in person whose session's verified email is still theirs, with or without a
    // workspace, from the dashboard's own origin. Never a bearer credential (refused inside) or the support platform.
    if (c.env.platformCaller) throw denied('DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.', { credential: 'dashboard' });
    const { invitationRecipient } = await import('./dashboard-auth.js');
    const user = await invitationRecipient(c.env, c.req.raw), userId = user.userId;
    const conversationId = c.req.valid('param').id, messageId = c.req.valid('json').messageId;
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
    conversation: z.object({ id: z.string(), channel: z.enum(['chat', 'email']), mode: Mode, verification: z.enum(['handoff', 'dmarc', 'signin', 'none']),
      signedIn: z.array(z.string()).describe('The messages of an email conversation its person confirmed, signed in (the claim), oldest first: each is answered once. Empty otherwise.') }),
    user: z.object({ id: z.string().nullable().describe('The person the conversation is bound to, as Nightmail stamps it; null when nobody is.'), name: z.string().nullable(), email: z.string().nullable(),
      mailboxProven: z.boolean().describe('Whether email is the account’s verified address and a sign-in proved it a mailbox the person reads within the last 30 days. Only then may an answer written from the account go to it, and only to email as stored.') }),
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
        (SELECT json_build_object('id', u.id, 'name', u.name, 'email', u.email, 'mailboxProven', ${mailboxProven(sql`u`)}) FROM nightmail_users u WHERE u.id = s.user_id) AS user,
        (SELECT json_build_object('id', id, 'name', name, 'role', role) FROM memberships WHERE id = s.workspace_id) AS workspace,
        coalesce((SELECT json_agg(json_build_object('id', id, 'name', name, 'role', role) ORDER BY name, id) FROM memberships WHERE s.workspace_id IS NULL OR s.channel = 'email' OR id = s.workspace_id), '[]') AS workspaces,
        (SELECT id FROM memberships WHERE id = s.content_workspace_id) AS "contentWorkspaceId",
        (SELECT page FROM support_handoffs WHERE conversation_id = s.id) AS page,
        EXISTS (SELECT FROM audit_events v WHERE v.action = 'support.view' AND v.actor_id = s.id AND v.workspace_id IS NOT NULL AND v.workspace_id NOT IN (SELECT id FROM memberships)) AS shrunk,
        s.workspace_id FROM s`);
    const { workspace_id: _w, ...scope } = row!;
    return { ...scope, user: scope.user ?? { id: null, name: null, email: null, mailboxProven: false } };
  }
  app.openapi(createRoute({ method: 'get', path: '/v1/support/scope', operationId: 'getSupportScope', tags, security, description: describe('Who this conversation is for and what it can read now: the person, the workspace in scope and their role there, content access, and whether they lost a workspace it read. Read it at the start of every turn.'),
    responses: { 200: response(Scope), ...errors } }), async c => c.json(await scopeOf(c.env.db, conversationOf(c).id), 200));
  app.openapi(createRoute({ method: 'post', path: '/v1/support/scope', operationId: 'updateSupportScope', tags, security, description: describe('Narrow an email conversation to one of the sender’s workspaces, or switch to another of them. A chat stays in the workspace it came from.'),
    request: { body: json(z.object({ workspaceId: z.string().min(1).max(100) }).strict()) }, responses: { 200: response(Scope), ...errors } }), async c => {
    const conversation = conversationOf(c), workspaceId = c.req.valid('json').workspaceId;
    if (conversation.channel === 'chat' && workspaceId !== conversation.workspaceId) throw new ApiError(409, 'SUPPORT_SCOPE_FIXED', 'A chat stays in the workspace the customer contacted support from.', 'workspaceId');
    const { rows } = await c.env.db.execute(sql`UPDATE support_conversations s SET workspace_id = ${workspaceId}
      WHERE s.id = ${conversation.id} AND EXISTS (SELECT FROM workspace_members m WHERE m.user_id = s.user_id AND m.workspace_id = ${workspaceId}) RETURNING s.id`);
    if (!rows.length) notFound('Workspace');
    return c.json(await scopeOf(c.env.db, conversation.id), 200);
  });
}
