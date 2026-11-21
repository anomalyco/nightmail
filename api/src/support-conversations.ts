import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { ApiError, dashboardSession, denied, errors, json, log, notFound, response, type App, type Ctx, type DbExecutor } from './core.js';
import { auditContext, auditInsert, operatorContext, requireOperator } from './audit.js';
import { CONVERSATION_ID, verifyHandoffToken, type RegisteredConversation } from './support-platform.js';
import type { MailHeader, Verdicts } from './db/mailbox.js';
import { productName } from './brand.js';

// Support conversations (api/README.md "Support integration"). The support platform registers each chat or email
// conversation it holds; Nightmail alone decides who it is for, from evidence it checks itself:
//
// - chat: its own signed handoff (POST /v1/contact-support) and the unused handoff row, once, shared with grants;
// - email: the stored From and DMARC verdict of a message it received at a support address (NIGHTMAIL_SUPPORT_ADDRESS_IDS);
// - sign-in: the person's own dashboard session, when its verified address is the email conversation's sender (claim).
//
// The support platform then reads through SupportPlatform.request(conversationId, …): the binding puts the conversation on
// the runtime, never in a header, query parameter or body, and supportGate (src/support.ts) answers for that user's live
// memberships within the conversation's scope, each route only for the roles its dashboard counterpart admits.

export type SupportRole = 'owner' | 'admin' | 'member';
const EVERYONE: SupportRole[] = ['owner', 'admin', 'member'], MANAGERS: SupportRole[] = ['owner', 'admin'];
type Ceiling = { method: 'GET' | 'POST'; path: string; roles: SupportRole[]; counterpart: string; views?: false };
/**
 * Every /v1/support route a conversation may call: the roles whose workspaces it reads, and the dashboard route that
 * decides them. A role reads a workspace here exactly when its own session may call the counterpart there. A route
 * missing here is refused to every conversation. `views: false`: reading it names no workspace's data, so it writes no
 * customer-visible "support viewed" row.
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
  { method: 'POST', path: '/v1/support/actions', roles: MANAGERS, counterpart: 'GET /v1/webhooks' },
  { method: 'GET', path: '/v1/support/actions/{id}', roles: MANAGERS, counterpart: 'GET /v1/webhooks' },
  { method: 'POST', path: '/v1/support/domains/{id}/verify', roles: MANAGERS, counterpart: 'GET /v1/domains' },
  { method: 'GET', path: '/v1/support/screen', roles: EVERYONE, counterpart: 'GET /v1/emails' },
  { method: 'GET', path: '/v1/support/campaigns', roles: EVERYONE, counterpart: 'GET /v1/campaigns' },
  { method: 'GET', path: '/v1/support/campaigns/{id}', roles: EVERYONE, counterpart: 'GET /v1/campaigns' },
  { method: 'GET', path: '/v1/support/emails/{id}/lint', roles: EVERYONE, counterpart: 'GET /v1/emails' },
  { method: 'GET', path: '/v1/support/campaigns/{id}/lint', roles: EVERYONE, counterpart: 'GET /v1/campaigns' },
  { method: 'GET', path: '/v1/support/audience/health', roles: EVERYONE, counterpart: 'GET /v1/lists' },
  { method: 'GET', path: '/v1/support/scope', roles: EVERYONE, counterpart: 'GET /v1/workspaces', views: false },
  { method: 'POST', path: '/v1/support/scope', roles: EVERYONE, counterpart: 'GET /v1/workspaces', views: false },
  // Notes are the person's own (src/support-notes.ts), filtered by their memberships, never a workspace's data.
  { method: 'GET', path: '/v1/support/notes', roles: EVERYONE, counterpart: 'GET /v1/workspaces', views: false },
  { method: 'POST', path: '/v1/support/notes', roles: EVERYONE, counterpart: 'GET /v1/workspaces', views: false },
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
/** The workspaces of a conversation's scope whose role reads this context section (a grant: all of them). */
export function sectionIds(c: Ctx, section: keyof typeof CONTEXT_SECTIONS, workspaces: { id: string; role: SupportRole }[]) {
  const roles: readonly SupportRole[] = CONTEXT_SECTIONS[section].roles;
  return c.get('support')?.conversation ? workspaces.filter(w => roles.includes(w.role)).map(w => w.id) : workspaces.map(w => w.id);
}
/** A conversation's workspaces where it reads received mail as a member does: only mail on receiving addresses. */
export const routedOnly = (c: Ctx, workspaces: { id: string; role: SupportRole }[]) => c.get('support')?.conversation ? workspaces.filter(w => w.role === 'member').map(w => w.id) : [];

/** Open conversations per person, checked at registration and at a claim. */
export const OPEN_CONVERSATIONS = 10;
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
const limitReached = () => new ApiError(429, 'SUPPORT_CONVERSATION_LIMIT', `This person already has ${OPEN_CONVERSATIONS} open support conversations. Close one first.`);
const openCount = (userId: unknown) => sql`(SELECT count(*)::int FROM support_conversations WHERE user_id = ${userId} AND status <> 'closed')`;
/**
 * Serializes admission for one person: every path that sets user_id (handoff, email, claim) takes this lock first, before
 * any conversation or handoff row, so its count is a later statement that sees every admission committed before it.
 */
const admit = (tx: DbExecutor, userId: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 39601))`);

/**
 * What a message Nightmail received at a support address proves: its sender, and whether that From is the one literal
 * address SES's DMARC PASS vouches for, as ingest judged it for every support address it reached (the link's
 * reply_author_verified) and as the stored verdict says. Anything less, or ambiguous, proves nothing. dkimAligned records
 * whether a sole signature of the From domain passed too.
 */
async function emailEvidence(db: DbExecutor, addressIds: string[], messageId: string) {
  const { rows: [m] } = await db.execute<{ thread_id: string; from_address: string; verdicts: Verdicts; headers: MailHeader[]; user_id: string | null; memberships: number; author_verified: boolean | null }>(sql`SELECT m.thread_id, m.from_address, m.verdicts, m.headers,
      u.id AS user_id, (SELECT count(*)::int FROM workspace_members wm WHERE wm.user_id = u.id) AS memberships, links.author_verified
    FROM mail_messages m LEFT JOIN nightmail_users u ON lower(u.email) = lower(m.from_address) AND u.email_verified
    CROSS JOIN LATERAL (SELECT bool_and(mm.reply_author_verified) AS author_verified FROM mailbox_messages mm JOIN mailboxes b ON b.id = mm.mailbox_id AND b.workspace_id = mm.workspace_id
      WHERE mm.message_id = m.id AND mm.workspace_id = m.workspace_id AND mm.direction = 'inbound' AND mm.mailbox_id = ANY(${sql.param(addressIds)}::text[])) links
    WHERE m.id = ${messageId} AND m.direction = 'inbound' AND links.author_verified IS NOT NULL`);
  if (!m) return null;
  const { literalFrom, soleAlignedSignature } = await import('./mailbox-ingest.js');
  const from = m.from_address.trim().toLowerCase(), domain = from.split('@')[1] ?? '', field = (name: string) => m.headers.filter(h => h.name.toLowerCase() === name).map(h => h.value);
  const fromFields = field('from'), dmarc = m.verdicts?.dmarc ?? null;
  const verified = /^[^\s@]+@[^\s@]+$/.test(from) && fromFields.length === 1 && literalFrom(fromFields[0]!, from) && dmarc === 'PASS' && m.author_verified === true;
  const dkimAligned = m.verdicts?.dkim === 'PASS' && soleAlignedSignature(field('dkim-signature'), domain);
  const userId = verified ? m.user_id : null;
  const mode: Row['mode'] = verified ? (userId && m.memberships > 0 ? 'member' : 'non_member') : m.user_id ? 'pending_signin' : 'unverified';
  return { from, threadId: m.thread_id, userId, mode, verification: verified ? 'dmarc' as const : 'none' as const, evidence: { message: messageId, dmarc, dkimAligned } };
}

export function registerSupportConversations(app: App) {
  const operatorSecurity: Record<string, string[]>[] = [{ bearerAuth: [] }, { dashboardSession: [] }, { secureDashboardSession: [] }];
  const sessionSecurity: Record<string, string[]>[] = [{ dashboardSession: [] }, { secureDashboardSession: [] }];
  const ConversationParam = z.object({ id: z.string().regex(CONVERSATION_ID) });

  app.openapi(createRoute({ hide: true, tags: ['Operator'], security: operatorSecurity, method: 'post', path: '/v1/operator/support/conversations', operationId: 'operatorRegisterSupportConversation',
    description: 'The support platform registers a conversation (the binding only). Nightmail checks the evidence itself and decides who it is for. A handoff opens one conversation or one grant, once; an email registers again with each message, which may bind the sender but never another person.',
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
        // A handoff opens one conversation or one grant (it is locked, then marked used in the same statement), for the
        // user and workspace it names, while they are still a member there.
        const { rows: [row] } = await tx.execute<Row & { handoff: boolean; used: boolean; used_by: string | null; is_member: boolean; taken: boolean }>(sql`WITH h AS (
            SELECT id, user_id, workspace_id, share_content, used_at, conversation_id FROM support_handoffs
            WHERE id = ${claims.id} AND user_id = ${claims.userId} AND workspace_id = ${claims.workspace.id} AND expires_at > now() FOR UPDATE
          ), member AS (SELECT FROM workspace_members m, h WHERE m.user_id = h.user_id AND m.workspace_id = h.workspace_id),
          c AS (
            INSERT INTO support_conversations(id, channel, user_id, verification, evidence, mode, workspace_id, content_workspace_id)
            SELECT ${conversationId}, 'chat', h.user_id, 'handoff', jsonb_build_object('handoff', h.id), 'member', h.workspace_id, CASE WHEN h.share_content THEN h.workspace_id END
            FROM h WHERE h.used_at IS NULL AND EXISTS (SELECT FROM member) AND ${openCount(sql`h.user_id`)} < ${OPEN_CONVERSATIONS}
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
      throw limitReached();
    }

    const addressIds = c.env.config.support?.addressIds ?? [];
    if (!addressIds.length) throw new ApiError(503, 'SUPPORT_NOT_CONFIGURED', 'Set NIGHTMAIL_SUPPORT_ADDRESS_IDS to the support addresses before registering email conversations.');
    const found = await emailEvidence(c.env.db, addressIds, body.evidence.messageId);
    if (!found) throw new ApiError(404, 'NOT_FOUND', 'Message was not found at a support address.');
    const details = { channel: 'email', message: body.evidence.messageId, dkimAligned: found.evidence.dkimAligned };
    const outcome = await c.env.db.transaction(async tx => {
      if (found.userId) await admit(tx, found.userId);
      const { rows: [existing] } = await tx.execute<Row>(sql`SELECT ${columns} FROM support_conversations WHERE id = ${conversationId} FOR UPDATE`);
      if (!existing) {
        if (found.userId && (await tx.execute<{ n: number }>(sql`SELECT ${openCount(found.userId)} AS n`)).rows[0]!.n >= OPEN_CONVERSATIONS) throw limitReached();
        const { rows: [row] } = await tx.execute<Row>(sql`WITH c AS (
            INSERT INTO support_conversations(id, channel, thread_id, user_id, pending_address, verification, evidence, mode)
            VALUES (${conversationId}, 'email', ${found.threadId}, ${found.userId}, ${found.from}, ${found.verification}, ${JSON.stringify(found.evidence)}::jsonb, ${found.mode}) RETURNING ${columns}
          ), logged AS (${audit(sql`c`, details)}) SELECT * FROM c`);
        return { row: row!, created: true };
      }
      if (existing.channel !== 'email') throw new ApiError(409, 'SUPPORT_CONVERSATION_EXISTS', 'That conversation is a chat, not an email conversation.');
      if (existing.status === 'closed') throw new ApiError(409, 'SUPPORT_CONVERSATION_CLOSED', 'That conversation is closed. Give the message a conversation of its own.');
      // One sender per conversation: another sender, or a message that no longer verifies as the bound person, gets a
      // conversation of its own. A bound conversation is never rebound or downgraded.
      if (existing.pending_address !== found.from) throw new ApiError(409, 'SUPPORT_CONVERSATION_SENDER', 'This message is from another sender. Give it a conversation of its own.');
      if (existing.user_id) {
        if (found.userId !== existing.user_id) throw new ApiError(409, 'SUPPORT_CONVERSATION_MISMATCH', 'This message does not verify as the conversation’s customer. Give it a conversation of its own.');
        return { row: existing, created: false };
      }
      if (found.userId && (await tx.execute<{ n: number }>(sql`SELECT ${openCount(found.userId)} AS n`)).rows[0]!.n >= OPEN_CONVERSATIONS) throw limitReached();
      const { rows: [row] } = await tx.execute<Row>(sql`WITH c AS (
          UPDATE support_conversations SET user_id = ${found.userId}, verification = ${found.verification}, mode = ${found.mode}, evidence = ${JSON.stringify(found.evidence)}::jsonb
          WHERE id = ${conversationId} RETURNING ${columns}
        ), logged AS (${audit(sql`c`, details)}) SELECT * FROM c`);
      return { row: row!, created: false };
    });
    log('info', { code: 'SUPPORT_CONVERSATION_REGISTERED', conversationId, channel: 'email', mode: outcome.row.mode });
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
  const Claimed = z.object({ id: z.string(), mode: Mode });
  app.openapi(createRoute({ hide: true, tags: ['Workspaces'], security: sessionSecurity, method: 'post', path: '/v1/support-conversations/{id}/claim', operationId: 'claimSupportConversation',
    description: `Continue an emailed support request signed in: binds the conversation to you when your verified email is the address that wrote to ${productName} support, and ${productName} support answers the waiting email. Anyone else gets 404.`,
    request: { params: ConversationParam }, responses: { 200: response(Claimed), ...errors } }), async c => {
    if (!c.env.config.multiTenant) return notFound('Endpoint');
    // Like accepting an invitation: a signed-in person whose session's verified email is still theirs, with or without a
    // workspace, from the dashboard's own origin. Never a bearer credential (refused inside) or the support platform.
    if (c.env.platformCaller) throw denied('DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.', { credential: 'dashboard' });
    const { verifiedDashboardUser, requireDashboardOrigin } = await import('./dashboard-auth.js');
    const { userId } = await verifiedDashboardUser(c.env, c.req.raw.headers, true);
    requireDashboardOrigin(c.env, c.req.raw);
    const conversationId = c.req.valid('param').id;
    const context = { ...auditContext(c), actor: { type: 'member' as const, id: userId, userId, via: 'dashboard' as const } };
    const claimed = await c.env.db.transaction(async tx => {
      await admit(tx, userId);
      // One binding, once: the row is locked, then changed only while it is still open, unbound and pending this
      // person's current verified address. A claim that lost the race answers only if it is already theirs.
      const { rows: [target] } = await tx.execute<Row>(sql`SELECT ${columns} FROM support_conversations WHERE id = ${conversationId} AND channel = 'email' AND status <> 'closed' FOR UPDATE`);
      if (!target) return null;
      if (target.user_id) {
        if (target.user_id !== userId) return null;
        // Bound to them already (by a later message's DMARC pass): this sign-in still counts for the mail that waited for it.
        await tx.execute(sql`UPDATE support_conversations SET evidence = coalesce(evidence, '{}'::jsonb) || jsonb_build_object('claimedAt', now()) WHERE id = ${conversationId}`);
        return { id: target.id, mode: target.mode };
      }
      const { rows: [row] } = await tx.execute<{ id: string | null; mode: z.infer<typeof Mode> | null; matches: boolean }>(sql`WITH me AS (
          SELECT id, lower(email) AS email FROM nightmail_users WHERE id = ${userId} AND email_verified AND email IS NOT NULL
        ), claimed AS (
          UPDATE support_conversations s SET user_id = me.id, verification = 'signin', evidence = s.evidence || jsonb_build_object('claimedAt', now()),
            mode = CASE WHEN EXISTS (SELECT FROM workspace_members WHERE user_id = me.id) THEN 'member' ELSE 'non_member' END
          FROM me WHERE s.id = ${conversationId} AND s.channel = 'email' AND s.status <> 'closed' AND s.user_id IS NULL AND lower(s.pending_address) = me.email
            AND ${openCount(sql`me.id`)} < ${OPEN_CONVERSATIONS} RETURNING s.id, s.mode
        ), logged AS (${auditInsert(context, { action: 'support.claim', workspaceId: null, target: { type: 'support_conversation', id: conversationId }, ticketRef: conversationId, internal: true },
          { where: sql`EXISTS (SELECT FROM claimed)` })})
        SELECT (SELECT id FROM claimed) AS id, (SELECT mode FROM claimed) AS mode, EXISTS (SELECT FROM me WHERE me.email = lower(${target.pending_address})) AS matches`);
      if (row?.id) return { id: row.id, mode: row.mode! };
      if (row?.matches) throw limitReached();
      return null;
    });
    if (!claimed) return notFound('Support conversation');
    // The support platform answers what waited for this sign-in once it reads the binding: wake it with the ID only
    // (again on a repeated claim, which recovers a lost wake). Nobody else's claim wakes anything.
    const { wakeSupport } = await import('./support-inbox.js');
    if (c.env.deferNudge) c.env.deferNudge(async () => { await wakeSupport(c.env.config, conversationId); });
    else await wakeSupport(c.env.config, conversationId);
    return c.json(claimed!, 200);
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
      signedInAt: z.string().nullable().describe('When the person last signed in to continue this email conversation (a claim), also when it was already bound to them; null otherwise.') }),
    user: z.object({ name: z.string().nullable(), email: z.string().nullable() }),
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
      SELECT json_build_object('id', s.id, 'channel', s.channel, 'mode', s.mode, 'verification', s.verification, 'signedInAt', s.evidence->>'claimedAt') AS conversation,
        (SELECT json_build_object('name', u.name, 'email', u.email) FROM nightmail_users u WHERE u.id = s.user_id) AS user,
        (SELECT json_build_object('id', id, 'name', name, 'role', role) FROM memberships WHERE id = s.workspace_id) AS workspace,
        coalesce((SELECT json_agg(json_build_object('id', id, 'name', name, 'role', role) ORDER BY name, id) FROM memberships WHERE s.workspace_id IS NULL OR s.channel = 'email' OR id = s.workspace_id), '[]') AS workspaces,
        (SELECT id FROM memberships WHERE id = s.content_workspace_id) AS "contentWorkspaceId",
        (SELECT page FROM support_handoffs WHERE conversation_id = s.id) AS page,
        EXISTS (SELECT FROM audit_events v WHERE v.action = 'support.view' AND v.actor_id = s.id AND v.workspace_id IS NOT NULL AND v.workspace_id NOT IN (SELECT id FROM memberships)) AS shrunk,
        s.workspace_id FROM s`);
    const { workspace_id: _w, ...scope } = row!;
    return { ...scope, user: scope.user ?? { name: null, email: null } };
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
