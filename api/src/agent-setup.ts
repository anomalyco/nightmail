import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { ApiError, chargeBudget, denied, digest, errors, id, IdParams, isoTime, json, randomSecret, requestOrigin, response, wrapModuleLoad, type App, type Ctx, type DbExecutor } from './core.js';
import { auditContext, auditInsert, ipNetwork, type AuditContext } from './audit.js';
import { apiKeyEnv, secretPrefixes, shownPrefix } from './brand.js';
import { mcpClientConfig, mcpServerUrl } from './mcp-clients.js';

/**
 * Agent setup: how a coding agent gets its own lasting API key without a person making one by hand (migration 469).
 *
 * - prompt: when a signed-in owner or admin copies the agent prompt, the dashboard mints a setup token (nm_setup_…) bound
 *   to them and their workspace, and puts it in the copied text. It works once, for 15 minutes; copying again replaces
 *   an unused one. The agent exchanges it at POST /v1/agent/setup.
 * - device (RFC 8628): an agent started without the prompt asks POST /v1/agent/device for a device code and a user code,
 *   the person opens /connect?code=…, signs in, chooses a workspace and approves, and the agent's polls of
 *   POST /v1/agent/device/token receive the key.
 *
 * Either way the agent gets one API key, "Agent (set up <date>)", listed and revocable under API keys like any other,
 * with AGENT_PERMISSIONS on every sender domain: what onboarding needs (sending, domains, inboxes and receiving, webhooks)
 * and the rest of the workspace's own resources. It never administers the workspace: keyAdminRefusal refuses it API keys
 * and agent tokens, and agentSetupRefusal billing and the credentials that would outlive it (inbox connection keys, inbox
 * keys, mail-client passwords); api_keys.agent_setup_id marks it. Members, invitations, the sending
 * connection and the workspace itself are a person's already: no API key reaches them.
 *
 * A secret is the row's ID (its selector) and a 256-bit verifier; only the verifier's SHA-256 is stored, and the
 * comparison is constant-time. The public routes are charged per client network, and user codes per person, so neither
 * can be guessed. The audit trail records each key as made by the person who copied the prompt or approved the code.
 */
export const AGENT_PERMISSIONS = ['read', 'send', 'manage'] as const;
const SETUP_MINUTES = 15, DEVICE_MINUTES = 15, POLL_SECONDS = 5;
// Rate limits, per minute: a client network's exchanges, device codes and polls, and a person's user code attempts.
const LIMITS = { exchange: 30, device: 30, poll: 120, userCode: 10 } as const;
// Device codes from every network together: a bound on the rows they keep (each a day past its 15 minutes).
const DEVICES_PER_MINUTE = 600;
// api_request_budgets rows for callers that have no workspace yet (core.ts chargeBudget), purged after a day like any.
const BUDGET = 'agent-setup';
// RFC 8628 §6.1: twenty consonants, no vowels (no words) and none easily confused.
const USER_CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';
const dashboardSecurity = [{ dashboardSession: [] }, { secureDashboardSession: [] }] as Record<string, string[]>[];
const tags = ['Auth'];
// An expired or replaced setup token or device code: 410 Gone, in the error shape every refusal has.
const gone = { 410: { description: 'Expired, or replaced by a newer one; use error.code.', content: errors[400]!.content } };

type Row = { id: string; kind: 'prompt' | 'device'; secret_hash: string; status: 'pending' | 'approved' | 'denied' | 'replaced' | 'used'; workspace_id: string | null; user_id: string | null;
  client_name: string | null; poll_interval: number; expired: boolean; too_soon: boolean };
type Issued = { key: string; keyId: string; name: string; workspaceId: string; workspaceName: string };

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), n => n.toString(16).padStart(2, '0')).join('');
/** A new setup token or device code for a new row: the row's ID, then the verifier whose hash the row keeps. */
async function newSecret(prefix: string) {
  const rowId = id('ags'), verifier = hex(32);
  return { rowId, secret: `${prefix}${rowId.slice(4)}.${verifier}`, hash: await digest(verifier) };
}
/** The row a presented secret names and its verifier's hash, or null for anything not shaped like one of ours. */
async function readSecret(prefix: string, value: string) {
  const match = new RegExp(`^${prefix}([0-9a-f]{32})\\.([0-9a-f]{64})$`).exec(value.trim());
  return match ? { rowId: `ags_${match[1]}`, hash: await digest(match[2]!) } : null;
}
// Compared in constant time, against a stand-in when there is no row, so a miss costs what a mismatch does.
const MISSING = '0'.repeat(64);
const matches = (row: Row | undefined, hash: string): row is Row => timingSafeEqual(Buffer.from(row?.secret_hash ?? MISSING, 'hex'), Buffer.from(hash, 'hex')) && !!row;

function newUserCode() {
  let code = '';
  while (code.length < 8) for (const byte of crypto.getRandomValues(new Uint8Array(16))) if (byte < 240 && code.length < 8) code += USER_CODE_LETTERS[byte % 20];
  return code;
}
/** The user code as people see and type it: BCDF-GHJK. */
const shownCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
/** A typed user code, any case, with or without its hyphen or spaces; null if it can't be one. */
function typedCode(value: string) {
  const code = value.toUpperCase().replace(/[\s-]/g, '');
  return new RegExp(`^[${USER_CODE_LETTERS}]{8}$`).test(code) ? code : null;
}

async function limited(c: Ctx, key: string, perMinute: number, message: string) {
  if (await chargeBudget(c.env, BUDGET, key, perMinute)) return;
  c.header('Retry-After', '60');
  throw new ApiError(429, 'AGENT_SETUP_RATE_LIMITED', message, undefined, true);
}
/** Charges the caller's client network (IPv4 /24, IPv6 /48) for one public agent setup request. */
const fromNetwork = (c: Ctx, lane: keyof typeof LIMITS) => limited(c, `${lane}:${ipNetwork(requestOrigin(c).clientIp) ?? 'unknown'}`, LIMITS[lane],
  'Too many agent setup requests from this network. Retry in a minute.');

/** A signed-in person in the dashboard; with admin, an owner or admin of the workspace the request acts in. */
function person(c: Ctx, admin: boolean) {
  const a = c.get('actor');
  if (a.credential !== 'dashboard') throw denied('DASHBOARD_AUTH_REQUIRED', 'A person sets up an agent, signed in to the dashboard.', { credential: 'dashboard', ...(admin ? { person: 'admin' as const } : {}) });
  if (admin && a.role !== 'owner' && a.role !== 'admin') throw denied('PERMISSION_DENIED', 'Only an owner or admin of this workspace sets up an agent: its key manages the workspace.', { person: 'admin' });
  return { workspaceId: a.workspaceId, userId: a.keyId.slice('user_'.length) };
}

/**
 * The agent's key, for a setup the person behind it still may make: an owner or admin of its workspace, checked now.
 * Written with the setup's end and an audit row naming that person, in the caller's transaction.
 */
async function issueKey(tx: DbExecutor, c: Ctx, row: Row): Promise<Issued | null> {
  const { rows: [member] } = await tx.execute<{ role: string; name: string }>(sql`SELECT m.role, w.name FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.workspace_id = ${row.workspace_id} AND m.user_id = ${row.user_id} FOR SHARE OF m`);
  if (member?.role !== 'owner' && member?.role !== 'admin') return null;
  const key = randomSecret(secretPrefixes.apiKey), keyId = id('key'), prefix = shownPrefix(key), name = `Agent (set up ${new Date().toISOString().slice(0, 10)})`;
  const context: AuditContext = { ...auditContext(c), actor: { type: 'member', id: row.user_id, userId: row.user_id, via: 'api', label: row.kind === 'device' ? 'Agent setup (device code)' : 'Agent setup (prompt)' } };
  await tx.execute(sql`WITH k AS (INSERT INTO api_keys(id, workspace_id, name, hash, prefix, permissions, domains, agent_setup_id)
      VALUES (${keyId}, ${row.workspace_id}, ${name}, ${await digest(key)}, ${prefix}, ${JSON.stringify(AGENT_PERMISSIONS)}::jsonb, '[]'::jsonb, ${row.id}) RETURNING id),
    s AS (UPDATE agent_setups SET status = 'used', used_at = now(), key_id = ${keyId} WHERE id = ${row.id})
    ${auditInsert(context, { action: 'api_key.create', workspaceId: row.workspace_id, target: { type: 'api_key', id: keyId },
      after: { name, permissions: AGENT_PERMISSIONS, domains: [], prefix: prefix.slice(0, 9), agentSetup: row.id, flow: row.kind, client: row.client_name ?? undefined } }, { from: sql`k` })}`);
  return { key, keyId, name, workspaceId: row.workspace_id!, workspaceName: member.name };
}
function issuedView(c: Ctx, issued: Issued) {
  const url = mcpServerUrl(c.env.config.publicUrl);
  return { key: issued.key, keyId: issued.keyId, name: issued.name, workspaceId: issued.workspaceId, workspaceName: issued.workspaceName, permissions: [...AGENT_PERMISSIONS], baseUrl: new URL(c.env.config.publicUrl).origin,
    mcp: { url, config: mcpClientConfig('generic', url, { key: issued.key, env: apiKeyEnv }) },
    nextStep: `Tell the person the key is for the workspace "${issued.workspaceName}", so they can confirm it's theirs. Save key as ${apiKeyEnv} in the project's environment (a gitignored .env, or the host's secrets), never in code or a commit: it is shown once. Send it as Authorization: Bearer on every request. A person revokes it under API keys.` };
}
const notAllowed = () => new ApiError(403, 'AGENT_SETUP_FORBIDDEN', 'The person who set this up is no longer an owner or admin of the workspace, so no key was made. Ask an owner or admin to set up the agent again.');

const Permissions = z.array(z.enum(['read', 'send', 'manage']));
const AgentKey = z.object({
  key: z.string().describe(`The API key (${secretPrefixes.apiKey}…), shown once. Save it as ${apiKeyEnv} in the project's environment, never in code or a commit.`),
  keyId: z.string(), name: z.string().describe('Agent (set up <date>), under API keys, where a person revokes it.'),
  workspaceId: z.string(), workspaceName: z.string().describe('The workspace\'s name: tell the person, so they can confirm the key is in theirs.'),
  permissions: Permissions.describe('read, send and manage, on every sender domain: send email, manage domains, inboxes, receiving, webhooks and campaigns. It can\'t create API keys, agent tokens, inbox connection keys, inbox keys or mail-client (IMAP/SMTP) passwords; members, billing and deleting the workspace are a person\'s.'),
  baseUrl: z.string().describe('The API origin to call.'),
  mcp: z.object({ url: z.string(), config: z.record(z.string(), z.unknown()).describe(`A remote MCP server entry that reads the key from ${apiKeyEnv}.`) }),
  nextStep: z.string(),
}).openapi('AgentKey');
const Token = z.string().min(1).max(300);
const UserCode = z.string().trim().min(1).max(20).openapi({ example: 'BCDF-GHJK' }).describe('The code the agent shows, with or without its hyphen.');
const DeviceStatus = z.enum(['pending', 'approved', 'denied', 'used', 'expired']);

export function registerAgentSetup(app: App) {
  // ---------- prompt: a setup token in the copied prompt ----------
  app.openapi(createRoute({ method: 'post', path: '/v1/agent/setup-tokens', operationId: 'createAgentSetupToken', tags, security: dashboardSecurity,
    summary: 'Mint a setup token for the agent prompt',
    description: `The dashboard calls this when an owner or admin copies the agent prompt: a one-time token, bound to them and this workspace, that the agent exchanges for its own API key (exchangeAgentSetupToken). It works once, within ${SETUP_MINUTES} minutes; a new one replaces their earlier unused one here. Dashboard session only.`,
    responses: { 201: response(z.object({ id: z.string(), token: z.string().describe(`${secretPrefixes.agentSetup}…, shown once.`), expiresAt: z.string(), permissions: Permissions }).openapi('AgentSetupToken')), ...errors } }), async c => {
    const { workspaceId, userId } = person(c, true), { rowId, secret, hash } = await newSecret(secretPrefixes.agentSetup);
    const expiresAt = new Date(Date.now() + SETUP_MINUTES * 60_000).toISOString();
    await c.env.db.execute(sql`WITH replaced AS (UPDATE agent_setups SET status = 'replaced', decided_at = now()
        WHERE kind = 'prompt' AND workspace_id = ${workspaceId} AND user_id = ${userId} AND status = 'pending'),
      made AS (INSERT INTO agent_setups(id, kind, secret_hash, workspace_id, user_id, expires_at) VALUES (${rowId}, 'prompt', ${hash}, ${workspaceId}, ${userId}, ${expiresAt}::timestamptz) RETURNING id)
      ${auditInsert(auditContext(c), { action: 'agent_setup.create', workspaceId, target: { type: 'agent_setup', id: rowId }, after: { flow: 'prompt', permissions: AGENT_PERMISSIONS, expiresAt } }, { from: sql`made` })}`);
    return c.json({ id: rowId, token: secret, expiresAt, permissions: [...AGENT_PERMISSIONS] }, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/agent/setup-tokens/{id}', operationId: 'getAgentSetupToken', tags, security: dashboardSecurity,
    summary: 'Whether the agent used its setup token',
    description: 'The setup token you minted in this workspace, so the dashboard can say when the agent connected: waiting, connected (with the key it received), expired, or replaced by a newer copy. Dashboard session only.',
    request: { params: IdParams }, responses: { 200: response(z.object({ id: z.string(), status: z.enum(['waiting', 'connected', 'expired', 'replaced']), expiresAt: z.string(),
      connectedAt: z.string().nullable(), keyId: z.string().nullable(), keyName: z.string().nullable() }).openapi('AgentSetupStatus')), ...errors } }), async c => {
    const { workspaceId, userId } = person(c, true), setupId = c.req.valid('param').id;
    const { rows: [row] } = await c.env.db.execute<{ status: Row['status']; expired: boolean; expires_at: string; used_at: string | null; key_id: string | null; key_name: string | null }>(sql`
      SELECT s.status, s.expires_at <= now() AS expired, s.expires_at::text, s.used_at::text, s.key_id, k.name AS key_name FROM agent_setups s
      LEFT JOIN api_keys k ON k.workspace_id = s.workspace_id AND k.id = s.key_id
      WHERE s.id = ${setupId} AND s.kind = 'prompt' AND s.workspace_id = ${workspaceId} AND s.user_id = ${userId}`);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Setup token was not found.');
    const status = row.status === 'used' ? 'connected' as const : row.status === 'replaced' ? 'replaced' as const : row.expired ? 'expired' as const : 'waiting' as const;
    return c.json({ id: setupId, status, expiresAt: isoTime(row.expires_at)!, connectedAt: isoTime(row.used_at), keyId: row.key_id, keyName: row.key_name }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/agent/setup', operationId: 'exchangeAgentSetupToken', tags, security: [],
    summary: 'Exchange a setup token for the agent\'s API key',
    description: `For a coding agent: the setup token in the prompt a person copied from the dashboard (${secretPrefixes.agentSetup}…) becomes a lasting API key for the agent, in that person's workspace. It works once, within ${SETUP_MINUTES} minutes of copying. A wrong token gets 400 SETUP_TOKEN_INVALID, a used one 409 SETUP_TOKEN_USED, and an expired or replaced one 410 SETUP_TOKEN_EXPIRED or SETUP_TOKEN_REPLACED: ask the person to copy the prompt again, or use the device flow (startAgentDeviceAuthorization). The key is shown once.`,
    request: { body: json(z.object({ token: Token.openapi({ example: `${secretPrefixes.agentSetup}${'0'.repeat(32)}.${'0'.repeat(64)}` }).describe('The setup token from the prompt.') }).strict()) },
    responses: { 201: response(AgentKey), ...errors, ...gone } }), async c => {
    await fromNetwork(c, 'exchange');
    const presented = await readSecret(secretPrefixes.agentSetup, c.req.valid('json').token);
    const invalid = () => new ApiError(400, 'SETUP_TOKEN_INVALID', 'This setup token is not valid. Copy the prompt from the dashboard again, or connect with a device code (POST /v1/agent/device).', 'token');
    if (!presented) throw invalid();
    const outcome = await c.env.db.transaction(async tx => {
      const { rows: [row] } = await tx.execute<Row>(sql`SELECT id, kind, secret_hash, status, workspace_id, user_id, client_name, poll_interval, expires_at <= now() AS expired, false AS too_soon
        FROM agent_setups WHERE id = ${presented.rowId} AND kind = 'prompt' FOR UPDATE`);
      if (!matches(row, presented.hash)) return 'invalid' as const;
      if (row.status === 'used') return 'used' as const;
      if (row.status === 'replaced') return 'replaced' as const;
      if (row.expired) return 'expired' as const;
      return await issueKey(tx, c, row) ?? 'forbidden' as const;
    });
    if (outcome === 'invalid') throw invalid();
    if (outcome === 'used') throw new ApiError(409, 'SETUP_TOKEN_USED', 'This setup token was already exchanged; it works once. If you lost the key, ask the person to revoke it under API keys and copy the prompt again.', 'token');
    if (outcome === 'replaced') throw new ApiError(410, 'SETUP_TOKEN_REPLACED', 'A newer copy of the prompt replaced this setup token. Use the token in the newest copy.', 'token');
    if (outcome === 'expired') throw new ApiError(410, 'SETUP_TOKEN_EXPIRED', `This setup token expired: it works for ${SETUP_MINUTES} minutes after the prompt is copied. Ask the person to copy it again, or connect with a device code (POST /v1/agent/device).`, 'token');
    if (outcome === 'forbidden') throw notAllowed();
    return c.json(issuedView(c, outcome), 201);
  });

  // ---------- device: RFC 8628 for an agent started without the prompt ----------
  app.openapi(createRoute({ method: 'post', path: '/v1/agent/device', operationId: 'startAgentDeviceAuthorization', tags, security: [],
    summary: 'Start the device flow for a coding agent',
    description: `For a coding agent without a setup token (RFC 8628): returns a device code to keep and a user code to show. Ask the person to open verification_uri_complete (or verification_uri and type the user code), sign in, choose a workspace and approve. Then poll pollAgentDeviceToken every interval seconds until it returns the key. Codes work once, for ${DEVICE_MINUTES} minutes.`,
    request: { body: { ...json(z.object({ client_name: z.string().trim().max(100).optional().openapi({ example: 'OpenCode' }).describe('What the agent is, shown to the person as its claim.') }).strict()), required: false } },
    responses: { 200: response(z.object({ device_code: z.string().describe(`${secretPrefixes.deviceCode}…: keep it private; only pollAgentDeviceToken takes it.`),
      user_code: z.string().describe('Show this to the person: they confirm it matches.'), verification_uri: z.string(), verification_uri_complete: z.string().describe('The page with the user code filled in: the link to give the person.'),
      expires_in: z.number().int(), interval: z.number().int().describe('Seconds to wait between polls.') }).openapi('AgentDeviceAuthorization')), ...errors } }), async c => {
    await fromNetwork(c, 'device');
    await limited(c, 'device:all', DEVICES_PER_MINUTE, 'Too many agents are starting the device flow right now. Retry in a minute.');
    const body = c.req.valid('json') as { client_name?: string } | undefined, { clientLabel } = await wrapModuleLoad(() => import('./mcp-auth.js'));
    const clientName = Array.from(clientLabel(body?.client_name)).slice(0, 100).join('') || null, { rowId, secret, hash } = await newSecret(secretPrefixes.deviceCode);
    const expiresAt = new Date(Date.now() + DEVICE_MINUTES * 60_000).toISOString();
    // A user code is unique among the rows kept (a day past expiry); a collision draws another.
    for (let attempt = 0; ; attempt++) {
      const code = newUserCode();
      const { rowCount } = await c.env.db.execute(sql`INSERT INTO agent_setups(id, kind, secret_hash, user_code, client_name, poll_interval, expires_at)
        VALUES (${rowId}, 'device', ${hash}, ${code}, ${clientName}, ${POLL_SECONDS}, ${expiresAt}::timestamptz) ON CONFLICT (user_code) DO NOTHING`);
      if (!rowCount && attempt < 4) continue;
      if (!rowCount) throw new ApiError(503, 'AGENT_SETUP_BUSY', 'Couldn’t issue a code. Retry.', undefined, true);
      const page = new URL('/connect', c.env.config.publicUrl);
      return c.json({ device_code: secret, user_code: shownCode(code), verification_uri: page.href, verification_uri_complete: `${page.href}?code=${shownCode(code)}`,
        expires_in: DEVICE_MINUTES * 60, interval: POLL_SECONDS }, 200);
    }
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/agent/device/token', operationId: 'pollAgentDeviceToken', tags, security: [],
    summary: 'Poll for the agent\'s API key',
    description: 'With the device code from startAgentDeviceAuthorization, every interval seconds until the person decides. Each answer follows RFC 8628: 400 AUTHORIZATION_PENDING (keep polling), 400 SLOW_DOWN (polled too soon: wait five seconds longer from now on), 400 ACCESS_DENIED (the person denied it: stop), 400 EXPIRED_TOKEN (start again), or 201 with the API key, once. Retry-After gives the seconds to wait.',
    request: { body: json(z.object({ device_code: Token.openapi({ example: `${secretPrefixes.deviceCode}${'0'.repeat(32)}.${'0'.repeat(64)}` }),
      grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code').optional().describe('Optional, as RFC 8628 clients send it.') }).strict()) },
    responses: { 201: response(AgentKey), ...errors } }), async c => {
    await fromNetwork(c, 'poll');
    const presented = await readSecret(secretPrefixes.deviceCode, c.req.valid('json').device_code);
    const invalid = () => new ApiError(400, 'DEVICE_CODE_INVALID', 'This device code is not valid. Start again with POST /v1/agent/device.', 'device_code');
    if (!presented) throw invalid();
    // The poll is recorded even when it is refused (slow_down), so the transaction returns what to answer.
    const outcome = await c.env.db.transaction(async tx => {
      const { rows: [row] } = await tx.execute<Row>(sql`SELECT id, kind, secret_hash, status, workspace_id, user_id, client_name, poll_interval, expires_at <= now() AS expired,
          coalesce(last_polled_at > now() - make_interval(secs => poll_interval), false) AS too_soon
        FROM agent_setups WHERE id = ${presented.rowId} AND kind = 'device' FOR UPDATE`);
      if (!matches(row, presented.hash)) return { error: 'invalid' as const };
      if (row.status === 'used') return { error: 'used' as const };
      if (row.expired) return { error: 'expired' as const };
      if (row.status === 'denied') return { error: 'denied' as const };
      if (row.too_soon) {
        const { rows: [slower] } = await tx.execute<{ poll_interval: number }>(sql`UPDATE agent_setups SET poll_interval = least(poll_interval + 5, 120), last_polled_at = now() WHERE id = ${row.id} RETURNING poll_interval`);
        return { error: 'slow' as const, interval: slower!.poll_interval };
      }
      await tx.execute(sql`UPDATE agent_setups SET last_polled_at = now() WHERE id = ${row.id}`);
      if (row.status !== 'approved') return { error: 'pending' as const, interval: row.poll_interval };
      const issued = await issueKey(tx, c, row);
      return issued ? { issued } : { error: 'forbidden' as const };
    });
    const wait = (error: ApiError, seconds: number) => Object.assign(error, { retryAfterSeconds: seconds });
    switch (outcome.error) {
      case 'invalid': throw invalid();
      case 'used': throw new ApiError(409, 'DEVICE_CODE_USED', 'This device code already received its key; it works once. If you lost the key, ask the person to revoke it under API keys, then start again.', 'device_code');
      case 'expired': throw new ApiError(400, 'EXPIRED_TOKEN', `This device code expired (${DEVICE_MINUTES} minutes). Start again with POST /v1/agent/device.`, 'device_code');
      case 'denied': throw new ApiError(400, 'ACCESS_DENIED', 'The person denied this agent. Stop polling.', 'device_code');
      case 'slow': throw wait(new ApiError(400, 'SLOW_DOWN', `Polled too soon. Wait ${outcome.interval} seconds between polls from now on.`, undefined, true), outcome.interval);
      case 'pending': throw wait(new ApiError(400, 'AUTHORIZATION_PENDING', `Waiting for the person to approve. Poll again in ${outcome.interval} seconds.`, undefined, true), outcome.interval);
      case 'forbidden': throw notAllowed();
    }
    return c.json(issuedView(c, outcome.issued!), 201);
  });

  // The page at /connect, signed in. Every call with a user code is charged to the person, so codes can't be guessed.
  const DeviceRequest = z.object({ userCode: z.string(), clientName: z.string().nullable().describe('What the agent says it is: its claim, not verified.'), status: DeviceStatus,
    createdAt: z.string(), expiresAt: z.string(), permissions: Permissions.describe('What its key gets once approved.') }).openapi('AgentDeviceRequest');
  const codeOf = async (c: Ctx, userId: string, value: string) => {
    await limited(c, `user-code:${userId}`, LIMITS.userCode, 'Too many codes tried. Wait a minute, then type the code your agent shows.');
    const code = typedCode(value);
    if (!code) throw new ApiError(422, 'VALIDATION_FAILED', 'A code is eight letters, like BCDF-GHJK.', 'userCode');
    return code;
  };
  // Why a decision found nothing to decide: no such code (404), or it is no longer pending.
  async function undecidable(c: Ctx, code: string): Promise<never> {
    const { rows: [row] } = await c.env.db.execute<{ status: Row['status']; expired: boolean }>(sql`SELECT status, expires_at <= now() AS expired FROM agent_setups WHERE kind = 'device' AND user_code = ${code}`);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'No agent is waiting with that code. Check it, or start again in your agent.');
    if (row.status === 'pending' && row.expired) throw new ApiError(410, 'DEVICE_CODE_EXPIRED', `This code expired (${DEVICE_MINUTES} minutes). Start again in your agent for a new one.`);
    throw new ApiError(409, 'DEVICE_CODE_DECIDED', `This code was already ${row.status === 'denied' ? 'denied' : 'approved'}.`);
  }
  app.openapi(createRoute({ method: 'post', path: '/v1/agent/device/lookup', operationId: 'lookUpAgentDevice', tags, security: dashboardSecurity,
    summary: 'Look up an agent waiting with a user code',
    description: `The /connect page: the agent behind a user code, before you approve or deny it. Each attempt counts against ${LIMITS.userCode} a minute per person. Dashboard session only.`,
    request: { body: json(z.object({ userCode: UserCode }).strict()) }, responses: { 200: response(DeviceRequest), ...errors } }), async c => {
    const { userId } = person(c, false), code = await codeOf(c, userId, c.req.valid('json').userCode);
    const { rows: [row] } = await c.env.db.execute<{ status: Row['status']; expired: boolean; client_name: string | null; created_at: string; expires_at: string }>(sql`
      SELECT status, expires_at <= now() AS expired, client_name, created_at::text, expires_at::text FROM agent_setups WHERE kind = 'device' AND user_code = ${code}`);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'No agent is waiting with that code. Check it, or start again in your agent.');
    const status = (row.status === 'pending' || row.status === 'approved') && row.expired ? 'expired' as const : row.status === 'replaced' ? 'expired' as const : row.status;
    return c.json({ userCode: shownCode(code), clientName: row.client_name, status, createdAt: isoTime(row.created_at)!, expiresAt: isoTime(row.expires_at)!, permissions: [...AGENT_PERMISSIONS] }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/agent/device/approve', operationId: 'approveAgentDevice', tags, security: dashboardSecurity,
    summary: 'Approve an agent waiting with a user code',
    description: 'Gives the agent behind the user code its own API key in the workspace this request acts in (X-Nightmail-Workspace), which you must own or administer. It receives the key on its next poll. Dashboard session only.',
    request: { body: json(z.object({ userCode: UserCode }).strict()) }, responses: { 200: response(z.object({ userCode: z.string(), status: z.literal('approved'), workspaceId: z.string() }).openapi('AgentDeviceApproval')), ...errors, ...gone } }), async c => {
    const { workspaceId, userId } = person(c, true), code = await codeOf(c, userId, c.req.valid('json').userCode);
    const { rows: [row] } = await c.env.db.execute<{ id: string }>(sql`WITH s AS (UPDATE agent_setups SET status = 'approved', workspace_id = ${workspaceId}, user_id = ${userId}, decided_at = now()
        WHERE kind = 'device' AND user_code = ${code} AND status = 'pending' AND expires_at > now() RETURNING id, client_name),
      a AS (${auditInsert(auditContext(c), { action: 'agent_setup.approve', workspaceId, target: { type: 'agent_setup', id: sql`s.id` },
        after: sql`jsonb_build_object('flow', 'device', 'client', s.client_name, 'permissions', ${JSON.stringify(AGENT_PERMISSIONS)}::jsonb)` }, { from: sql`s` })})
      SELECT id FROM s`);
    if (!row) await undecidable(c, code);
    return c.json({ userCode: shownCode(code), status: 'approved' as const, workspaceId }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/agent/device/deny', operationId: 'denyAgentDevice', tags, security: dashboardSecurity,
    summary: 'Deny an agent waiting with a user code',
    description: 'The agent behind the user code gets no key: its next poll is answered ACCESS_DENIED. Dashboard session only.',
    request: { body: json(z.object({ userCode: UserCode }).strict()) }, responses: { 200: response(z.object({ userCode: z.string(), status: z.literal('denied') }).openapi('AgentDeviceDenial')), ...errors, ...gone } }), async c => {
    const { workspaceId, userId } = person(c, false), code = await codeOf(c, userId, c.req.valid('json').userCode);
    const { rows: [row] } = await c.env.db.execute<{ id: string }>(sql`WITH s AS (UPDATE agent_setups SET status = 'denied', user_id = ${userId}, decided_at = now()
        WHERE kind = 'device' AND user_code = ${code} AND status = 'pending' AND expires_at > now() RETURNING id, client_name),
      a AS (${auditInsert(auditContext(c), { action: 'agent_setup.deny', workspaceId, target: { type: 'agent_setup', id: sql`s.id` }, after: sql`jsonb_build_object('flow', 'device', 'client', s.client_name)` }, { from: sql`s` })})
      SELECT id FROM s`);
    if (!row) await undecidable(c, code);
    return c.json({ userCode: shownCode(code), status: 'denied' as const }, 200);
  });
}
