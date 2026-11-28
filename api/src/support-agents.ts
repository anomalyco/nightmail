import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { ApiError, errors, notFound } from './core/errors.js';
import { isoTime, json, response } from './core/http.js';
import type { App, Ctx, DbExecutor } from './core/types.js';
import { auditInsert, operatorContext, operatorRequired } from './audit.js';
import { operatorActor, type OperatorIdentity } from './operator.js';
import { productName } from './brand.js';
import { newUserCode, shownCode, typedCode } from './user-code.js';

// A staff member's agent in the support inbox (migration 578). Staff work through their own AI agents, signed in over
// MCP as themselves: an operator's sign-in lists three tools (mcp-support.ts) that call the inbox's own routes in
// process (support-inbox.ts), as that person, through that agent.
//
// The dashboard gives operator powers only to a session whose sign-in proved staff (operator.ts operatorActor: the role
// and a staff Google Workspace sign-in). An MCP token doesn't carry that proof, so an agent never inherits it: each
// connection is approved on purpose, by its own person, from a session that passed that check.
//
// - An agent's first call opens a request: a code and a link to /operator/agents, for 15 minutes, and the call is refused
//   with them (a human step). Calling again while it waits shows the same code.
// - The person opens the link signed in as staff, sees which connection asks (its client, as the connection names
//   itself), compares the code and approves. Only their own connection: nobody approves an agent for someone else.
// - The approval names one connection, its approval ID (kept across token refreshes) and the account service's consent
//   behind its sign-in, so another install of the same client, or a fresh sign-in, asks again. It lasts 30 days, is
//   listed under Operator → Agents and revoked there.
// - Every call checks it all again: SUPPORT_AGENT_ACCESS, the MCP approval itself (not revoked or expired), the operator
//   role, and the approval for this connection (live, unrevoked, and given since the role was last granted: losing the
//   role ends every approval that person gave, and getting it back revives none).
//
// What an agent may do is what the tools offer: read the inbox and one conversation, reply to that conversation's
// customer, add a note, mark done, hand back to the support AI, and send or discard a held answer. Never a recipient,
// never an approval, a pause, a refund or a limit. A reply goes through the dashboard's own path (support-inbox.ts
// queueReply), at most SUPPORT_AGENT_REPLIES_PER_HOUR an hour per person, and marking done or discarding a held answer
// at most SUPPORT_AGENT_CLOSES_PER_HOUR; the message, the conversation's events and
// the audit trail (via mcp, "via agent") record the agent, and the customer sees a staff reply.

export const SUPPORT_AGENT_DAYS = 30;
export const SUPPORT_AGENT_REQUEST_MINUTES = 15;
/** Replies (and held answers sent) through an agent, per staff member, in any hour. */
export const SUPPORT_AGENT_REPLIES_PER_HOUR = 20;
/**
 * Conversations marked done (which resolves their tickets) and held answers discarded through an agent, per staff member,
 * in any hour. The same as replies: an agent closes no more than it could have answered in that hour, which a real pass
 * through Needs you stays under, and a message that talks it into closing everything stops at 20, each on the trail.
 */
export const SUPPORT_AGENT_CLOSES_PER_HOUR = 20;

const CONVERSATION = 'conv_[a-z2-7]{26}', MESSAGE = 'msg_[a-z2-7]{16}';
const AGENT_READS = new RegExp(`^/v1/operator/support-inbox(?:/${CONVERSATION})?$`);
const AGENT_WRITES = new RegExp(`^/v1/operator/support-inbox/${CONVERSATION}/(?:replies|notes|done|resume|drafts/${MESSAGE}/(?:send|discard))$`);
/** The support inbox routes a staff member's agent may call (support.ts operatorGate lets nothing else through). */
export const supportAgentRoute = (method: string, path: string) => method === 'GET' ? AGENT_READS.test(path) : method === 'POST' && AGENT_WRITES.test(path);

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const newApprovalId = () => `sag_${Array.from(crypto.getRandomValues(new Uint8Array(26)), b => BASE32[b & 31]).join('')}`;
const approvalLink = (c: Ctx, code: string) => `${new URL('/operator/agents', c.env.config.publicUrl).href}?code=${shownCode(code)}`;
/** What an approval lets the agent do and never lets it do, as the approval page says it. */
export const SUPPORT_AGENT_CAN = 'Read the support inbox, reply to customers as you, add notes, mark done, send or discard held AI answers.';
export const SUPPORT_AGENT_NEVER = 'Choose who a reply goes to, approve proposals, change limits or billing.';

export type AgentOperator = OperatorIdentity & { agent: { approvalId: string; grantId: string } };
const agentsOff = () => new ApiError(403, 'SUPPORT_AGENTS_OFF', `Agents can’t use the support inbox on this installation. Use the dashboard.`);

/**
 * The staff member behind an agent's call to a support inbox route (support-inbox.ts staff), checked now, or a refusal.
 * Without an approval for this connection, the refusal is the human step: a request's code and link (opened here, or
 * the one still waiting), in error.details.
 */
export async function agentOperator(c: Ctx): Promise<AgentOperator> {
  const a = c.get('actor');
  if (!c.env.config.multiTenant || a?.credential !== 'mcp' || !a.keyId.startsWith('mcp_') || !a.userId || !supportAgentRoute(c.req.method, c.req.path)) throw operatorRequired();
  if (!c.env.config.supportAgentAccess) throw agentsOff();
  // Every sign-in the account service issues names its consent; one that doesn't can't be told apart from another.
  if (!a.mcpConsent) throw new ApiError(403, 'SUPPORT_AGENT_SIGN_IN', 'This sign-in can’t be approved for the support inbox. Sign in again in your MCP client, then retry.');
  const { rows: [row] } = await c.env.db.execute<{ email: string; role: string | null; approval: string | null }>(sql`SELECT u.email, p.role,
      (SELECT s.id FROM support_agent_approvals s WHERE s.grant_id = g.id AND s.consent = ${a.mcpConsent} AND s.user_id = g.user_id AND s.revoked_at IS NULL
        AND s.expires_at > now() AND s.approved_at >= p.granted_at) AS approval
    FROM nightmail_resource_grants g JOIN nightmail_users u ON u.id = g.user_id LEFT JOIN platform_operators p ON p.user_id = g.user_id
    WHERE g.id = ${a.keyId} AND g.user_id = ${a.userId} AND NOT g.revoked AND g.expires_at > clock_timestamp()`);
  if (!row) throw operatorRequired();
  if (row.role !== 'operator') throw new ApiError(403, 'OPERATOR_REQUIRED', `The support inbox tools are for ${productName} staff with the operator role.`);
  if (!row.approval) throw await approvalRequired(c, c.env.db, a.keyId, a.mcpConsent, a.userId);
  await c.env.db.execute(sql`UPDATE support_agent_approvals SET last_used_at = now() WHERE id = ${row.approval} AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`);
  return { userId: a.userId, email: row.email, role: 'operator', agent: { approvalId: row.approval, grantId: a.keyId } };
}

/** The refusal that asks for an approval: this connection's waiting request, or a new one (its own expired ones go). */
async function approvalRequired(c: Ctx, db: DbExecutor, grantId: string, consent: string, userId: string) {
  await db.execute(sql`DELETE FROM support_agent_requests WHERE grant_id = ${grantId} AND consent = ${consent} AND expires_at < now() - interval '1 day'`);
  let { rows: [request] } = await db.execute<{ user_code: string; expires_at: string }>(sql`SELECT user_code, expires_at::text AS expires_at FROM support_agent_requests
    WHERE grant_id = ${grantId} AND consent = ${consent} AND user_id = ${userId} AND status = 'pending' AND expires_at > now() ORDER BY created_at DESC LIMIT 1`);
  // A code is unique among the requests kept; a collision draws another.
  for (let attempt = 0; !request && attempt < 3; attempt++) ({ rows: [request] } = await db.execute<{ user_code: string; expires_at: string }>(sql`INSERT INTO support_agent_requests(id, user_code, grant_id, consent, user_id, expires_at)
      VALUES (${crypto.randomUUID()}, ${newUserCode()}, ${grantId}, ${consent}, ${userId}, now() + make_interval(mins => ${SUPPORT_AGENT_REQUEST_MINUTES}::int))
      ON CONFLICT (user_code) DO NOTHING RETURNING user_code, expires_at::text AS expires_at`));
  if (!request) throw new ApiError(503, 'SUPPORT_AGENT_BUSY', 'Couldn’t issue a code. Retry.', undefined, true);
  const code = shownCode(request.user_code), url = approvalLink(c, request.user_code);
  const refusal = new ApiError(403, 'SUPPORT_AGENT_APPROVAL_REQUIRED', `Ask the person you’re signed in as to approve you for the support inbox. Show them this link on its own line, and ask them to open it signed in to ${productName} as staff:\n${url}\nThey check that the code ${code} matches and approve. It works for ${SUPPORT_AGENT_REQUEST_MINUTES} minutes; after that, call again for a new one.`);
  refusal.details = [{ userCode: code, url, expiresAt: isoTime(request.expires_at) }];
  return refusal;
}

// ---------- the person's side: Operator → Agents ----------

const UserCode = z.string().trim().min(1).max(20).describe('The code the agent shows, with or without its hyphen.');
const Agent = z.object({ connectionId: z.string().describe('The MCP connection (its approval\u2019s ID).'), client: z.string().nullable().describe('The client, as the connection names itself: its claim, never verified.'),
  profile: z.string().nullable().describe('The label on its MCP URL (?profile=), if any.'), connectedAt: z.string() });
const AgentRequest = z.object({ userCode: z.string(), agent: Agent, status: z.enum(['pending', 'approved', 'denied', 'expired']), createdAt: z.string(), expiresAt: z.string(),
  can: z.string().describe('What approving lets the agent do.'), never: z.string().describe('What it never can.'), days: z.number().int().describe('How long an approval lasts.') }).openapi('SupportAgentRequest');
const Approval = z.object({ id: z.string(), agent: Agent, approvedAt: z.string(), expiresAt: z.string(), lastUsedAt: z.string().nullable() }).openapi('SupportAgentApproval');
type AgentRow = { grant_id: string; client_id: string | null; profile: string | null; connected_at: string | null };
/** A connection as the approval page shows it; the client's name is the connection's own claim (mcp-auth.ts clientLabel, loaded on demand). */
async function agentsOf<T extends AgentRow>(rows: T[]) {
  const { clientLabel } = await import('./mcp-auth.js');
  return rows.map(r => ({ row: r, agent: { connectionId: r.grant_id, client: clientLabel(r.client_id) || null, profile: r.profile, connectedAt: isoTime(r.connected_at) ?? '' } satisfies z.infer<typeof Agent> }));
}
const codeOf = (value: string) => {
  const code = typedCode(value);
  if (!code) throw new ApiError(422, 'VALIDATION_FAILED', 'A code is eight letters, like BCDF-GHJK.', 'userCode');
  return code;
};
/** The signed-in staff member, from a dashboard session that passed the staff check, on an installation that allows agents. */
async function person(c: Ctx, level: 'operator' | 'operator:read') {
  if (c.env.platformCaller || c.get('actor')?.credential !== 'dashboard') throw operatorRequired();
  const operator = await operatorActor(c, level);
  if (!c.env.config.supportAgentAccess) throw agentsOff();
  return operator;
}
const context = (c: Ctx, operator: OperatorIdentity) => operatorContext(c, { id: operator.userId, role: operator.role, via: 'console', userId: operator.userId });
const noRequest = () => new ApiError(404, 'NOT_FOUND', 'No agent of yours is waiting with that code. Check it, or call the support tools again in your agent for a new one.');

export function registerSupportAgents(app: App) {
  const security: Record<string, string[]>[] = [{ dashboardSession: [] }, { secureDashboardSession: [] }];
  const tags = ['Operator'];
  app.openapi(createRoute({ hide: true, tags, security, method: 'post', path: '/v1/operator/support-agents/lookup', operationId: 'operatorLookUpSupportAgent',
    description: 'The approval page (the operator role, a staff sign-in): the agent behind a code, which must be one of your own connections. Anyone else\u2019s code is 404.',
    request: { body: json(z.object({ userCode: UserCode }).strict()) }, responses: { 200: response(AgentRequest), ...errors } }), async c => {
    const operator = await person(c, 'operator'), code = codeOf(c.req.valid('json').userCode);
    const { rows: [row] } = await c.env.db.execute<AgentRow & { status: 'pending' | 'approved' | 'denied'; expired: boolean; created_at: string; expires_at: string }>(sql`SELECT r.grant_id, g.client_id, g.profile,
        g.created_at::text AS connected_at, r.status, r.expires_at <= now() AS expired, r.created_at::text AS created_at, r.expires_at::text AS expires_at
      FROM support_agent_requests r LEFT JOIN nightmail_resource_grants g ON g.id = r.grant_id AND g.user_id = r.user_id AND NOT g.revoked
      WHERE r.user_code = ${code} AND r.user_id = ${operator.userId}`);
    if (!row) throw noRequest();
    const [{ agent }] = await agentsOf([row]);
    return c.json({ userCode: shownCode(code), agent, status: row.status === 'pending' && (row.expired || !row.client_id) ? 'expired' as const : row.status,
      createdAt: isoTime(row.created_at)!, expiresAt: isoTime(row.expires_at)!, can: SUPPORT_AGENT_CAN, never: SUPPORT_AGENT_NEVER, days: SUPPORT_AGENT_DAYS }, 200);
  });
  app.openapi(createRoute({ hide: true, tags, security, method: 'post', path: '/v1/operator/support-agents/approve', operationId: 'operatorApproveSupportAgent',
    description: `Approve one of your own agent connections for the support inbox (the operator role, a staff sign-in), for ${SUPPORT_AGENT_DAYS} days: it replaces an earlier approval of the same connection. On the audit trail.`,
    request: { body: json(z.object({ userCode: UserCode }).strict()) }, responses: { 201: response(Approval), ...errors } }), async c => {
    const operator = await person(c, 'operator'), code = codeOf(c.req.valid('json').userCode);
    const approval = await c.env.db.transaction(async tx => {
      const { rows: [request] } = await tx.execute<AgentRow & { id: string; consent: string; status: string; expired: boolean }>(sql`SELECT r.id, r.grant_id, r.consent, r.status, r.expires_at <= now() AS expired,
          g.client_id, g.profile, g.created_at::text AS connected_at
        FROM support_agent_requests r LEFT JOIN nightmail_resource_grants g ON g.id = r.grant_id AND g.user_id = r.user_id AND NOT g.revoked
        WHERE r.user_code = ${code} AND r.user_id = ${operator.userId} FOR UPDATE OF r`);
      if (!request) throw noRequest();
      if (request.status !== 'pending') throw new ApiError(409, 'SUPPORT_AGENT_DECIDED', `This code was already ${request.status}.`);
      if (request.expired || !request.client_id) throw new ApiError(410, 'SUPPORT_AGENT_EXPIRED', 'This code expired, or its connection ended. Call the support tools again in your agent for a new one.');
      await tx.execute(sql`UPDATE support_agent_requests SET status = 'approved', decided_at = now() WHERE id = ${request.id}`);
      await tx.execute(sql`UPDATE support_agent_approvals SET revoked_at = now() WHERE grant_id = ${request.grant_id} AND consent = ${request.consent} AND revoked_at IS NULL`);
      const { rows: [made] } = await tx.execute<{ id: string; approved_at: string; expires_at: string }>(sql`INSERT INTO support_agent_approvals(id, grant_id, consent, user_id, approved_at, expires_at)
        VALUES (${newApprovalId()}, ${request.grant_id}, ${request.consent}, ${operator.userId}, clock_timestamp(), clock_timestamp() + make_interval(days => ${SUPPORT_AGENT_DAYS}::int))
        RETURNING id, approved_at::text AS approved_at, expires_at::text AS expires_at`);
      const [{ agent }] = await agentsOf([request]);
      await tx.execute(auditInsert(context(c, operator), { action: 'support.agent_approve', workspaceId: null, userId: operator.userId, target: { type: 'mcp_connection', id: request.grant_id },
        details: { approval: made!.id, client: agent.client, days: SUPPORT_AGENT_DAYS }, internal: true }));
      return { id: made!.id, agent, approvedAt: isoTime(made!.approved_at)!, expiresAt: isoTime(made!.expires_at)!, lastUsedAt: null };
    });
    return c.json(approval, 201);
  });
  app.openapi(createRoute({ hide: true, tags, security, method: 'post', path: '/v1/operator/support-agents/deny', operationId: 'operatorDenySupportAgent',
    description: 'Turn down one of your own agents waiting with a code (operator:read is enough): it gets nothing, and calling again shows a new code.',
    request: { body: json(z.object({ userCode: UserCode }).strict()) }, responses: { 200: response(z.object({ userCode: z.string(), status: z.literal('denied') })), ...errors } }), async c => {
    const operator = await person(c, 'operator:read'), code = codeOf(c.req.valid('json').userCode);
    const { rows: [denied] } = await c.env.db.execute<{ grant_id: string }>(sql`WITH r AS (UPDATE support_agent_requests SET status = 'denied', decided_at = now()
        WHERE user_code = ${code} AND user_id = ${operator.userId} AND status = 'pending' RETURNING grant_id),
      a AS (${auditInsert(context(c, operator), { action: 'support.agent_deny', workspaceId: null, userId: operator.userId, target: { type: 'mcp_connection', id: sql`r.grant_id` }, internal: true }, { from: sql`r` })})
      SELECT grant_id FROM r`);
    if (!denied) throw noRequest();
    return c.json({ userCode: shownCode(code), status: 'denied' as const }, 200);
  });
  app.openapi(createRoute({ hide: true, tags, security, method: 'get', path: '/v1/operator/support-agents', operationId: 'operatorListSupportAgents',
    description: 'Your agents approved for the support inbox and still working, newest first (operator:read is enough to see and revoke them).',
    responses: { 200: response(z.object({ data: z.array(Approval) })), ...errors } }), async c => {
    const operator = await person(c, 'operator:read');
    const { rows } = await c.env.db.execute<AgentRow & { id: string; approved_at: string; expires_at: string; last_used_at: string | null }>(sql`SELECT s.id, s.grant_id, g.client_id, g.profile,
        g.created_at::text AS connected_at, s.approved_at::text AS approved_at, s.expires_at::text AS expires_at, s.last_used_at::text AS last_used_at
      FROM support_agent_approvals s JOIN nightmail_resource_grants g ON g.id = s.grant_id AND g.user_id = s.user_id AND NOT g.revoked
      JOIN platform_operators p ON p.user_id = s.user_id AND p.role = 'operator' AND s.approved_at >= p.granted_at
      WHERE s.user_id = ${operator.userId} AND s.revoked_at IS NULL AND s.expires_at > now() ORDER BY s.approved_at DESC, s.id DESC LIMIT 50`);
    return c.json({ data: (await agentsOf(rows)).map(({ row: r, agent }) => ({ id: r.id, agent, approvedAt: isoTime(r.approved_at)!, expiresAt: isoTime(r.expires_at)!, lastUsedAt: isoTime(r.last_used_at) })) }, 200);
  });
  app.openapi(createRoute({ hide: true, tags, security, method: 'delete', path: '/v1/operator/support-agents/{id}', operationId: 'operatorRevokeSupportAgent',
    description: 'Revoke one of your agents\u2019 support inbox approval: its next call is refused. On the audit trail.',
    request: { params: z.object({ id: z.string().regex(/^sag_[a-z2-7]{26}$/) }) }, responses: { 200: response(z.object({ id: z.string(), revoked: z.literal(true) })), ...errors } }), async c => {
    const operator = await person(c, 'operator:read'), id = c.req.valid('param').id;
    const { rows: [revoked] } = await c.env.db.execute<{ id: string }>(sql`WITH s AS (UPDATE support_agent_approvals SET revoked_at = now()
        WHERE id = ${id} AND user_id = ${operator.userId} AND revoked_at IS NULL RETURNING id, grant_id),
      a AS (${auditInsert(context(c, operator), { action: 'support.agent_revoke', workspaceId: null, userId: operator.userId, target: { type: 'mcp_connection', id: sql`s.grant_id` },
        details: { approval: id }, internal: true }, { from: sql`s` })})
      SELECT id FROM s`);
    if (!revoked) notFound('Agent approval');
    return c.json({ id, revoked: true as const }, 200);
  });
}
