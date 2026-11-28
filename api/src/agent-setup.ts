import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { ApiError, denied, errors, wrapModuleLoad } from './core/errors.js';
import { chargeBudget, digest, id, IdParams, isoTime, json, randomSecret, response } from './core/http.js';
import { requestOrigin, type App, type Ctx, type DbExecutor } from './core/types.js';
import { auditContext, auditInsert, ipNetwork, type AuditContext } from './audit.js';
import { apiKeyEnv, productName, secretPrefixes, shownPrefix } from './brand.js';
import { agentKeyName } from './agent-key-name.js';
import { mcpClientConfig, mcpServerUrl } from './mcp-clients.js';
import { newUserCode, shownCode, typedCode } from './user-code.js';

/**
 * Agent setup: how a coding agent gets its own lasting API key without a person making one by hand (migration 469).
 *
 * - prompt: when a signed-in owner or admin copies the agent prompt, the dashboard mints a setup token (nm_setup_…) bound
 *   to them and their workspace, and puts it in the copied text. It works once, for 15 minutes; copying again replaces
 *   an unused one. The agent exchanges it at POST /v1/agent/setup.
 * - device (RFC 8628): an agent started without the prompt asks POST /v1/agent/device for a device code and a user code,
 *   the person opens /connect?code=…, signs in, chooses a workspace and approves, and the agent's polls of
 *   POST /v1/agent/device/token receive the key. Every answer the agent gets while it waits (nextStep, each pending
 *   poll) gives it the link to show on its own line: a person who never sees the link never approves.
 * - an agent holding a spent setup token (expired, replaced or used: production agents came back to a prompt hours
 *   later) gets a device code addressed to that token's person and workspace, so their dashboard shows the agent waiting
 *   (GET /v1/agent/device/waiting) with a button to /connect. That says only whom the agent asks; approving is unchanged.
 *   A code nobody approved in time is renewed once, on the poll that finds it expired, with the new link.
 *
 * Either way the agent gets one API key named after the client it says it is ("OpenCode, set up <date>", or "Agent, set
 * up <date>" when it doesn't say; api_keys.agent_client keeps the claim), listed and revocable under API keys like any other,
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
// api_request_budgets rows for callers that have no workspace yet (core/http.ts chargeBudget), purged after a day like any.
const BUDGET = 'agent-setup';
const dashboardSecurity = [{ dashboardSession: [] }, { secureDashboardSession: [] }] as Record<string, string[]>[];
const tags = ['Auth'];
// An expired or replaced setup token or device code: 410 Gone, in the error shape every refusal has.
const gone = { 410: { description: 'Expired, or replaced by a newer one; use error.code.', content: errors[400]!.content } };

type Row = { id: string; kind: 'prompt' | 'device'; secret_hash: string; status: 'pending' | 'approved' | 'denied' | 'replaced' | 'used'; workspace_id: string | null; user_id: string | null;
  client_name: string | null; poll_interval: number; expired: boolean; too_soon: boolean };
type DeviceRow = Row & { user_code: string; for_workspace_id: string | null; for_user_id: string | null; for_prompt_copied_at: string | null; renewed_from: string | null; minutes_left: number };
/** Whom a device code asks: the person and workspace of the setup token the agent held. */
type Asker = { workspaceId: string; userId: string; copiedAt: string };
type Issued = { key: string; keyId: string; name: string; workspaceId: string; workspaceName: string };
/** What the agent says it is, as one short line (mcp-auth.ts clientLabel), or null. */
async function clientClaim(value: string | undefined) {
  const { clientLabel } = await wrapModuleLoad(() => import('./mcp-auth.js'));
  return Array.from(clientLabel(value)).slice(0, 100).join('') || null;
}

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

/** The /connect link with the user code filled in: the one link the person needs. */
const approvalLink = (c: Ctx, code: string) => `${new URL('/connect', c.env.config.publicUrl).href}?code=${shownCode(code.replace('-', ''))}`;
/**
 * Where a signed-in owner or admin copies a fresh agent prompt: the quicker way to the same key. In production the
 * person who never opened a device code's link (two codes, 30 minutes, 300 polls) connected in 25 seconds with a fresh
 * copy: they act where they already are, and nothing has to cross from the agent's window to theirs.
 */
const promptLink = (c: Ctx) => `${new URL('/docs', c.env.config.publicUrl).href}#agent-prompt`;
const freshPrompt = (c: Ctx) => `a fresh copy of the agent prompt (Copy agent prompt, in ${productName} at ${promptLink(c)}), whose setup token connects you in seconds`;
/** The words that ask the person to approve: the link alone on its line, so any agent relays it as a link. */
const askToOpen = (c: Ctx, code: string) => `show the person this link, on its own line, and ask them to open it and approve you:\n${approvalLink(c, code)}\n`;

/**
 * A new device code (RFC 8628 §3.2), with nextStep saying in words what the agent shows the person. asker: the person
 * and workspace whose setup token the agent held, so their dashboard lists it; renewedFrom: the expired code it replaces.
 */
async function startDevice(c: Ctx, db: DbExecutor, clientName: string | null, asker: Asker | null, renewedFrom: string | null = null) {
  const { rowId, secret, hash } = await newSecret(secretPrefixes.deviceCode);
  const expiresAt = new Date(Date.now() + DEVICE_MINUTES * 60_000).toISOString();
  // A user code is unique among the rows kept (a day past expiry); a collision draws another.
  for (let attempt = 0; ; attempt++) {
    const code = newUserCode();
    const { rowCount } = await db.execute(sql`INSERT INTO agent_setups(id, kind, secret_hash, user_code, client_name, poll_interval, expires_at, for_workspace_id, for_user_id, for_prompt_copied_at, renewed_from)
      VALUES (${rowId}, 'device', ${hash}, ${code}, ${clientName}, ${POLL_SECONDS}, ${expiresAt}::timestamptz, ${asker?.workspaceId ?? null}, ${asker?.userId ?? null}, ${asker?.copiedAt ?? null}::timestamptz, ${renewedFrom})
      ON CONFLICT (user_code) DO NOTHING`);
    if (!rowCount && attempt < 4) continue;
    if (!rowCount) throw new ApiError(503, 'AGENT_SETUP_BUSY', 'Couldn’t issue a code. Retry.', undefined, true);
    const link = approvalLink(c, code);
    return { device_code: secret, user_code: shownCode(code), verification_uri: link.slice(0, link.indexOf('?')), verification_uri_complete: link,
      expires_in: DEVICE_MINUTES * 60, interval: POLL_SECONDS,
      nextStep: `Now ${askToOpen(c, code)}They sign in, check that the code ${shownCode(code)} matches and approve. It works for ${DEVICE_MINUTES} minutes${asker ? ', and their dashboard shows you waiting' : ''}. Meanwhile poll POST /v1/agent/device/token with this device_code every ${POLL_SECONDS} seconds until it returns your key. If they'd rather, they can give you ${freshPrompt(c)}.` };
  }
}
/** A device code for an agent, unless every network together has started too many this minute. */
const deviceIfAllowed = async (c: Ctx, db: DbExecutor, clientName: string | null, asker: Asker | null, renewedFrom: string | null = null) =>
  await chargeBudget(c.env, BUDGET, 'device:all', DEVICES_PER_MINUTE) ? await startDevice(c, db, clientName, asker, renewedFrom) : null;

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
  const key = randomSecret(secretPrefixes.apiKey), keyId = id('key'), prefix = shownPrefix(key), name = agentKeyName(row.client_name);
  const context: AuditContext = { ...auditContext(c), actor: { type: 'member', id: row.user_id, userId: row.user_id, via: 'api', label: row.kind === 'device' ? 'Agent setup (device code)' : 'Agent setup (prompt)' } };
  await tx.execute(sql`WITH k AS (INSERT INTO api_keys(id, workspace_id, name, hash, prefix, permissions, domains, agent_setup_id, agent_client)
      VALUES (${keyId}, ${row.workspace_id}, ${name}, ${await digest(key)}, ${prefix}, ${JSON.stringify(AGENT_PERMISSIONS)}::jsonb, '[]'::jsonb, ${row.id}, ${row.client_name}) RETURNING id),
    s AS (UPDATE agent_setups SET status = 'used', used_at = now(), key_id = ${keyId}, client_name = ${row.client_name} WHERE id = ${row.id})
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
/**
 * A setup token or device code that already gave its key, presented again (an agent that dropped the response, or a
 * second poller): which key it was, from the row the secret names, so an agent that kept it goes on with it instead of
 * starting over. The secret was shown once and is never sent again, and no second key is made: every repeat gets this
 * same answer. Only the key's own name, prefix and ID, never its workspace.
 */
async function alreadyIssued(c: Ctx, setupId: string, code: 'SETUP_TOKEN_USED' | 'DEVICE_CODE_USED', again: string) {
  const what = code === 'SETUP_TOKEN_USED' ? 'This setup token' : 'This device code', field = code === 'SETUP_TOKEN_USED' ? 'token' : 'device_code';
  const { rows: [key] } = await c.env.db.execute<{ id: string; name: string; prefix: string; used_at: string; revoked_at: string | null }>(sql`
    SELECT k.id, k.name, k.prefix, s.used_at::text, k.revoked_at::text FROM agent_setups s JOIN api_keys k ON k.workspace_id = s.workspace_id AND k.id = s.key_id WHERE s.id = ${setupId}`);
  if (!key) return new ApiError(409, code, `${what} already gave its key; it works once. If you lost the key, ask the person to revoke it under API keys, then ${again}`, field);
  const issuedAt = isoTime(key.used_at)!, named = `"${key.name}" (${key.prefix}…)`;
  const refusal = new ApiError(409, code, key.revoked_at
    ? `${what} already gave its key, ${named}, at ${issuedAt}, and it has since been revoked. ${again[0]!.toUpperCase()}${again.slice(1)}`
    : `${what} already gave its key at ${issuedAt}: ${named}, ID in error.details. It is shown once, so it isn't sent again and no second key is made: use the key you saved from that response (it starts with ${key.prefix}). If you didn't save it, ask the person to revoke ${named} under API keys, then ${again}`, field);
  refusal.details = [{ keyId: key.id, name: key.name, prefix: key.prefix, issuedAt, revokedAt: isoTime(key.revoked_at) }];
  return refusal;
}
const notAllowed = () => new ApiError(403, 'AGENT_SETUP_FORBIDDEN', 'The person who set this up is no longer an owner or admin of the workspace, so no key was made. Ask an owner or admin to set up the agent again.');

const Permissions = z.array(z.enum(['read', 'send', 'manage']));
const AgentKey = z.object({
  key: z.string().describe(`The API key (${secretPrefixes.apiKey}…), shown once. Save it as ${apiKeyEnv} in the project's environment, never in code or a commit.`),
  keyId: z.string(), name: z.string().describe('"<client_name>, set up <date>" ("Agent, set up <date>" without one), under API keys, where a person revokes it.'),
  workspaceId: z.string(), workspaceName: z.string().describe('The workspace\'s name: tell the person, so they can confirm the key is in theirs.'),
  permissions: Permissions.describe('read, send and manage, on every sender domain: send email, manage domains, inboxes, receiving, webhooks and campaigns. It can\'t create API keys, agent tokens, inbox connection keys, inbox keys or mail-client (IMAP/SMTP) passwords; members, billing and deleting the workspace are a person\'s.'),
  baseUrl: z.string().describe('The API origin to call.'),
  mcp: z.object({ url: z.string(), config: z.record(z.string(), z.unknown()).describe(`A remote MCP server entry that reads the key from ${apiKeyEnv}.`) }),
  nextStep: z.string(),
}).openapi('AgentKey');
const Token = z.string().min(1).max(300);
const ClientName = z.string().trim().max(100).optional().openapi({ example: 'OpenCode' }).describe('What the agent is, shown to the person as its claim and naming its key ("OpenCode, set up <date>").');
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
    summary: 'Exchange a setup token for an API key',
    description: `For a coding agent: the setup token in the prompt a person copied from the dashboard (${secretPrefixes.agentSetup}…) becomes a lasting API key for the agent, in that person's workspace, named after client_name. It works once, within ${SETUP_MINUTES} minutes of copying. A wrong token gets 400 SETUP_TOKEN_INVALID, a used one 409 SETUP_TOKEN_USED (naming the key it gave, in error.details, never the key again), and an expired or replaced one 410 SETUP_TOKEN_EXPIRED or SETUP_TOKEN_REPLACED with a device code in error.details[0] (startAgentDeviceAuthorization's answer) for the person who copied it to approve: show them its link and poll it. The key is shown once.`,
    request: { body: json(z.object({ token: Token.openapi({ example: `${secretPrefixes.agentSetup}${'0'.repeat(32)}.${'0'.repeat(64)}` }).describe('The setup token from the prompt.'),
      client_name: ClientName }).strict()) },
    responses: { 201: response(AgentKey), ...errors, ...gone } }), async c => {
    await fromNetwork(c, 'exchange');
    const body = c.req.valid('json'), presented = await readSecret(secretPrefixes.agentSetup, body.token);
    const invalid = () => new ApiError(400, 'SETUP_TOKEN_INVALID', 'This setup token is not valid. Copy the prompt from the dashboard again, or connect with a device code (POST /v1/agent/device).', 'token');
    if (!presented) throw invalid();
    const client = await clientClaim(body.client_name);
    const outcome = await c.env.db.transaction(async tx => {
      const { rows: [row] } = await tx.execute<Row & { created_at: string }>(sql`SELECT id, kind, secret_hash, status, workspace_id, user_id, client_name, poll_interval, expires_at <= now() AS expired, false AS too_soon, created_at::text
        FROM agent_setups WHERE id = ${presented.rowId} AND kind = 'prompt' FOR UPDATE`);
      if (!matches(row, presented.hash)) return 'invalid' as const;
      if (row.status === 'used') return 'used' as const;
      if (row.status === 'replaced' || row.expired) return { spent: row.status === 'replaced' ? 'replaced' as const : 'expired' as const, asker: { workspaceId: row.workspace_id!, userId: row.user_id!, copiedAt: row.created_at } };
      return await issueKey(tx, c, { ...row, client_name: client }) ?? 'forbidden' as const;
    });
    if (outcome === 'invalid') throw invalid();
    if (outcome === 'used') throw await alreadyIssued(c, presented.rowId, 'SETUP_TOKEN_USED', 'ask them to copy the prompt again, or connect with a device code (POST /v1/agent/device).');
    if (outcome === 'forbidden') throw notAllowed();
    if ('spent' in outcome) {
      // The agent has no key and the person who gave it this token is known: ask them, where they'll see it.
      const device = await deviceIfAllowed(c, c.env.db, client, outcome.asker);
      const why = outcome.spent === 'replaced' ? 'A newer copy of the prompt replaced this setup token. If you have the newest copy, use its token.'
        : `This setup token expired: it works for ${SETUP_MINUTES} minutes after the prompt is copied.`;
      const refusal = new ApiError(410, outcome.spent === 'replaced' ? 'SETUP_TOKEN_REPLACED' : 'SETUP_TOKEN_EXPIRED', device
        ? `${why} ${outcome.spent === 'replaced' ? 'Otherwise ask' : 'Ask'} the person for ${freshPrompt(c)}. Or ${askToOpen(c, device.user_code)}Their dashboard shows you waiting. Then poll POST /v1/agent/device/token with error.details[0].device_code every ${device.interval} seconds until it returns your key.`
        : `${why} Ask the person to copy it again, or connect with a device code (POST /v1/agent/device).`, 'token');
      if (device) refusal.details = [device];
      throw refusal;
    }
    return c.json(issuedView(c, outcome), 201);
  });

  // ---------- device: RFC 8628 for an agent started without the prompt ----------
  app.openapi(createRoute({ method: 'post', path: '/v1/agent/device', operationId: 'startAgentDeviceAuthorization', tags, security: [],
    summary: 'Start the device flow for an agent',
    description: `For a coding agent without a setup token (RFC 8628): returns a device code to keep and a user code to show. Show the person verification_uri_complete as a link on its own line and ask them to open it, sign in, check the code and approve; nextStep says so in words. Then poll pollAgentDeviceToken every interval seconds until it returns the key. Codes work once, for ${DEVICE_MINUTES} minutes. With setup_token (one from the person's prompt that expired or was replaced before it was used), their dashboard shows you waiting.`,
    request: { body: { ...json(z.object({ client_name: ClientName,
      setup_token: Token.optional().describe('The setup token from the person\'s prompt, even if it expired or was replaced: their dashboard then shows you waiting for their approval. One that was used already addresses nobody.') }).strict()), required: false } },
    responses: { 200: response(z.object({ device_code: z.string().describe(`${secretPrefixes.deviceCode}…: keep it private; only pollAgentDeviceToken takes it.`),
      user_code: z.string().describe('Show this to the person: they confirm it matches.'), verification_uri: z.string(), verification_uri_complete: z.string().describe('The page with the user code filled in: the link to give the person.'),
      expires_in: z.number().int(), interval: z.number().int().describe('Seconds to wait between polls.'),
      nextStep: z.string().describe('What to do now, in words: the link to show the person on its own line, then the polling.') }).openapi('AgentDeviceAuthorization')), ...errors } }), async c => {
    await fromNetwork(c, 'device');
    await limited(c, 'device:all', DEVICES_PER_MINUTE, 'Too many agents are starting the device flow right now. Retry in a minute.');
    const body = c.req.valid('json') as { client_name?: string; setup_token?: string } | undefined;
    let asker: Asker | null = null;
    if (body?.setup_token !== undefined) {
      // A genuine setup token that never gave a key names its person: they gave it to an agent that still has none. One
      // that was used did give its agent a key, and lives on in that agent's transcript: anyone who later reads it could
      // otherwise put "<any name> is waiting for your approval" in that person's dashboard for a key of their own (device
      // code phishing). It starts a code that asks nobody in particular.
      const presented = await readSecret(secretPrefixes.agentSetup, body.setup_token);
      const { rows: [row] } = presented ? await c.env.db.execute<Row & { created_at: string }>(sql`SELECT id, secret_hash, status, workspace_id, user_id, created_at::text FROM agent_setups WHERE id = ${presented.rowId} AND kind = 'prompt'`) : { rows: [] };
      if (!presented || !matches(row, presented.hash)) throw new ApiError(400, 'SETUP_TOKEN_INVALID', 'This setup token is not valid. Leave setup_token out to start a device code without it.', 'setup_token');
      if (row.status !== 'used') asker = { workspaceId: row.workspace_id!, userId: row.user_id!, copiedAt: row.created_at };
    }
    return c.json(await startDevice(c, c.env.db, await clientClaim(body?.client_name), asker), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/agent/device/token', operationId: 'pollAgentDeviceToken', tags, security: [],
    summary: 'Poll for the agent\'s API key',
    description: 'With the device code from startAgentDeviceAuthorization, every interval seconds until the person decides. Each answer follows RFC 8628: 400 AUTHORIZATION_PENDING (keep polling), 400 SLOW_DOWN (polled too soon: wait five seconds longer from now on), 400 ACCESS_DENIED (the person denied it: stop), 400 EXPIRED_TOKEN (nobody approved in time: the first such answer carries a new device code in error.details[0], once; after that start again), or 201 with the API key, once. Each pending answer repeats the link to show the person. A poll after that gets 409 DEVICE_CODE_USED naming the key it gave (error.details: keyId, name, prefix, issuedAt, revokedAt), never the key again and never a second one: use the key you saved. Retry-After gives the seconds to wait.',
    request: { body: json(z.object({ device_code: Token.openapi({ example: `${secretPrefixes.deviceCode}${'0'.repeat(32)}.${'0'.repeat(64)}` }),
      grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code').optional().describe('Optional, as RFC 8628 clients send it.') }).strict()) },
    responses: { 201: response(AgentKey), ...errors } }), async c => {
    await fromNetwork(c, 'poll');
    const presented = await readSecret(secretPrefixes.deviceCode, c.req.valid('json').device_code);
    const invalid = () => new ApiError(400, 'DEVICE_CODE_INVALID', 'This device code is not valid. Start again with POST /v1/agent/device.', 'device_code');
    if (!presented) throw invalid();
    // The poll is recorded even when it is refused (slow_down), so the transaction returns what to answer.
    const outcome = await c.env.db.transaction(async tx => {
      const { rows: [row] } = await tx.execute<DeviceRow>(sql`SELECT id, kind, secret_hash, status, workspace_id, user_id, client_name, poll_interval, expires_at <= now() AS expired,
          coalesce(last_polled_at > now() - make_interval(secs => poll_interval), false) AS too_soon, user_code, for_workspace_id, for_user_id, for_prompt_copied_at::text, renewed_from,
          greatest(1, round(extract(epoch FROM expires_at - now()) / 60))::int AS minutes_left
        FROM agent_setups WHERE id = ${presented.rowId} AND kind = 'device' FOR UPDATE`);
      if (!matches(row, presented.hash)) return { error: 'invalid' as const };
      if (row.status === 'used') return { error: 'used' as const };
      if (row.status === 'replaced') return { error: 'renewed' as const };
      // Nobody approved it in time (the person never saw the link, or saw it late): one new code, with the link, so the
      // agent can ask again at once. A renewed code that expires too is not renewed again.
      if (row.expired && row.status === 'pending' && !row.renewed_from) {
        const asker = row.for_workspace_id && row.for_user_id && row.for_prompt_copied_at ? { workspaceId: row.for_workspace_id, userId: row.for_user_id, copiedAt: row.for_prompt_copied_at } : null;
        const renewed = await deviceIfAllowed(c, tx, row.client_name, asker, row.id);
        if (renewed) await tx.execute(sql`UPDATE agent_setups SET status = 'replaced', decided_at = now() WHERE id = ${row.id}`);
        return { error: 'expired' as const, renewed };
      }
      if (row.expired) return { error: 'expired' as const };
      if (row.status === 'denied') return { error: 'denied' as const };
      if (row.too_soon) {
        const { rows: [slower] } = await tx.execute<{ poll_interval: number }>(sql`UPDATE agent_setups SET poll_interval = least(poll_interval + 5, 120), last_polled_at = now() WHERE id = ${row.id} RETURNING poll_interval`);
        return { error: 'slow' as const, interval: slower!.poll_interval };
      }
      await tx.execute(sql`UPDATE agent_setups SET last_polled_at = now() WHERE id = ${row.id}`);
      if (row.status !== 'approved') return { error: 'pending' as const, interval: row.poll_interval, code: row.user_code, minutesLeft: row.minutes_left };
      const issued = await issueKey(tx, c, row);
      return issued ? { issued } : { error: 'forbidden' as const };
    });
    const wait = (error: ApiError, seconds: number) => Object.assign(error, { retryAfterSeconds: seconds });
    switch (outcome.error) {
      case 'invalid': throw invalid();
      case 'used': throw await alreadyIssued(c, presented.rowId, 'DEVICE_CODE_USED', 'start again with POST /v1/agent/device.');
      case 'renewed': throw new ApiError(400, 'EXPIRED_TOKEN', 'This device code expired and was renewed: poll the device code that answer gave you, or start again with POST /v1/agent/device and show the person its new link.', 'device_code');
      case 'expired': {
        const renewed = 'renewed' in outcome ? outcome.renewed : null;
        const expired = new ApiError(400, 'EXPIRED_TOKEN', renewed
          ? `Nobody approved this code within ${DEVICE_MINUTES} minutes, so it expired: the person may not have seen the link. Ask them for ${freshPrompt(c)}. Or here is a new code: ${askToOpen(c, renewed.user_code)}Then poll with error.details[0].device_code every ${renewed.interval} seconds.`
          : `This device code expired (${DEVICE_MINUTES} minutes). Start again with POST /v1/agent/device and show the person its new link.`, 'device_code');
        if (renewed) expired.details = [renewed];
        throw expired;
      }
      case 'denied': throw new ApiError(400, 'ACCESS_DENIED', 'The person denied this agent. Stop polling.', 'device_code');
      case 'slow': throw wait(new ApiError(400, 'SLOW_DOWN', `Polled too soon. Wait ${outcome.interval} seconds between polls from now on.`, undefined, true), outcome.interval);
      case 'pending': throw wait(new ApiError(400, 'AUTHORIZATION_PENDING', `Waiting for the person to approve (${outcome.minutesLeft} min left). If they haven't opened it yet, ${askToOpen(c, outcome.code!)}Poll again in ${outcome.interval} seconds.`, undefined, true), outcome.interval);
      case 'forbidden': throw notAllowed();
    }
    return c.json(issuedView(c, outcome.issued!), 201);
  });

  // The page at /connect, signed in. Every call with a user code is charged to the person, so codes can't be guessed.
  const DeviceRequest = z.object({ userCode: z.string(), clientName: z.string().nullable().describe('What the agent says it is: its claim, not verified.'), status: DeviceStatus,
    createdAt: z.string(), expiresAt: z.string(), permissions: Permissions.describe('What its key gets once approved.'),
    suggestedWorkspaceId: z.string().nullable().describe('The workspace of your own setup token that the agent held, which the page chooses first; null otherwise. Approving may still choose any workspace you own or administer.'),
    promptCopiedAt: z.string().nullable().describe('When you copied the prompt whose setup token the agent held; null for an agent that asked without one of yours. A request long after your last copy, or when you started no agent, isn\'t yours.') }).openapi('AgentDeviceRequest');
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
    if (row.status === 'replaced') throw new ApiError(410, 'DEVICE_CODE_EXPIRED', `This code expired (${DEVICE_MINUTES} minutes), and your agent was given a new one: open the link it shows now.`);
    throw new ApiError(409, 'DEVICE_CODE_DECIDED', `This code was already ${row.status === 'denied' ? 'denied' : 'approved'}.`);
  }
  app.openapi(createRoute({ method: 'post', path: '/v1/agent/device/lookup', operationId: 'lookUpAgentDevice', tags, security: dashboardSecurity,
    summary: 'Look up an agent by user code',
    description: `The /connect page: the agent behind a user code, before you approve or deny it. Each attempt counts against ${LIMITS.userCode} a minute per person. Dashboard session only.`,
    request: { body: json(z.object({ userCode: UserCode }).strict()) }, responses: { 200: response(DeviceRequest), ...errors } }), async c => {
    const { userId } = person(c, false), code = await codeOf(c, userId, c.req.valid('json').userCode);
    const { rows: [row] } = await c.env.db.execute<{ status: Row['status']; expired: boolean; client_name: string | null; created_at: string; expires_at: string; suggested: string | null; copied: string | null }>(sql`
      SELECT status, expires_at <= now() AS expired, client_name, created_at::text, expires_at::text, CASE WHEN for_user_id = ${userId} THEN for_workspace_id END AS suggested,
        CASE WHEN for_user_id = ${userId} THEN for_prompt_copied_at::text END AS copied
      FROM agent_setups WHERE kind = 'device' AND user_code = ${code}`);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'No agent is waiting with that code. Check it, or start again in your agent.');
    const status = (row.status === 'pending' || row.status === 'approved') && row.expired ? 'expired' as const : row.status === 'replaced' ? 'expired' as const : row.status;
    return c.json({ userCode: shownCode(code), clientName: row.client_name, status, createdAt: isoTime(row.created_at)!, expiresAt: isoTime(row.expires_at)!, permissions: [...AGENT_PERMISSIONS],
      suggestedWorkspaceId: row.suggested, promptCopiedAt: isoTime(row.copied) }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/agent/device/waiting', operationId: 'listWaitingAgentDevices', tags, security: dashboardSecurity,
    summary: 'Agents waiting for your approval',
    description: 'Agents that asked for a device code with a setup token you copied in this workspace, still waiting for an approval, newest first: the dashboard shows each with a button to /connect. An agent that started without one isn\'t listed: only its link reaches you. Dashboard session only.',
    responses: { 200: response(z.object({ data: z.array(z.object({ userCode: z.string(), clientName: z.string().nullable().describe('What the agent says it is: its claim, not verified.'),
      createdAt: z.string(), expiresAt: z.string(), promptCopiedAt: z.string().describe('When you copied the prompt whose setup token it held.') })) }).openapi('WaitingAgentDevices')), ...errors } }), async c => {
    const { workspaceId, userId } = person(c, true);
    const { rows } = await c.env.db.execute<{ user_code: string; client_name: string | null; created_at: string; expires_at: string; copied: string }>(sql`
      SELECT user_code, client_name, created_at::text, expires_at::text, for_prompt_copied_at::text AS copied FROM agent_setups
      WHERE kind = 'device' AND status = 'pending' AND for_workspace_id = ${workspaceId} AND for_user_id = ${userId} AND expires_at > now()
      ORDER BY created_at DESC LIMIT 5`);
    return c.json({ data: rows.map(row => ({ userCode: shownCode(row.user_code), clientName: row.client_name, createdAt: isoTime(row.created_at)!, expiresAt: isoTime(row.expires_at)!, promptCopiedAt: isoTime(row.copied)! })) }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/agent/device/approve', operationId: 'approveAgentDevice', tags, security: dashboardSecurity,
    summary: 'Approve an agent by user code',
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
