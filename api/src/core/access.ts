import { z } from '@hono/zod-openapi';
import type { Ctx, Permission, Actor, MailboxAccess } from './types.js';
import { requiredOf, denied, type Required, credentialLimits, FULL_ACCESS_KEY, ApiError, fullAccessRefusal, notFound } from './errors.js';

export function actor(c: Ctx, action: Permission | 'editContent' = 'read'): Actor {
  const value = c.get('actor');
  // Dashboard roles include content editing. A scoped machine grant is still bounded by its
  // original permission contract: send alone does not delegate contact or template management.
  const permission = action === 'editContent' ? (c.env.config.multiTenant && value?.credential === 'dashboard' ? 'send' : 'manage') : action;
  if (!value || (!value.permissions.includes('manage') && !value.permissions.includes(permission))) throw value?.credential === 'apiKey'
    ? missingPermission(value, permission, requiredOf(c, action)) : denied('PERMISSION_DENIED', `This operation requires ${permission} permission.`, requiredOf(c, action));
  return value;
}
/**
 * PERMISSION_DENIED for an API key that lacks a permission (onboarding's Send only key reading back what it sent, most
 * often): what the key can do, then how to get one that can: the same key with the permission added (API keys → Edit
 * keeps its secret, so nothing is redeployed), or a full-access key. denied() adds what the endpoint needs.
 */
export function missingPermission(a: Pick<Actor, 'permissions' | 'domains' | 'credential'>, permission: Permission, need: Required) {
  const add = permission === 'manage' ? 'Make it Full access' : `Add ${permission === 'read' ? 'Read' : 'Send'} to it`;
  return denied('PERMISSION_DENIED', `${credentialLimits(a)} ${add} in the dashboard (API keys → Edit; it keeps its secret), or use a full-access key: ${FULL_ACCESS_KEY}.`, need);
}
/**
 * The one rule for changes that outlive the credential making them: API keys, sending and receiving webhooks, endpoints,
 * routes, rules, inbound keys, mail client passwords and inbox connections. A temporary agent token lasts at most a
 * day, so it reads and tests these but never creates, changes or removes them. Every such write calls this; the MCP
 * listing asks lastingRefusal of the same routes (keyAdminRoute, receivingAdminRoute, lastingRoute).
 */
export function lasting(c: Ctx, what: string) {
  const refusal = lastingRefusal(c.get('actor'), what, requiredOf(c, 'manage'));
  if (refusal) throw refusal;
}
export const lastingRefusal = (a: Actor | undefined, what: string, need: Required = {}) => a?.credential === 'agentToken'
  ? denied('CREDENTIAL_DELEGATION_FORBIDDEN', `Temporary agent tokens cannot ${what}. Use the dashboard, an API key or the MCP approval itself.`, { ...need, credential: 'lasting' }) : null;
/** What `lasting` refuses, for the areas that share a wording (sending and receiving webhooks; API keys and inbound keys). */
export const WEBHOOK_CHANGE = 'create, change or delete webhooks or read their signing secrets', KEY_CHANGE = 'create, list or revoke API keys';
/** What `lasting` refuses on receiving hosts: adding, changing or removing one, turning receiving on or off, or its catch-all. */
export const RECEIVING_HOST_CHANGE = 'add, change or remove receiving hosts';
/**
 * Receiving configuration (routing, rules, endpoints, inbox connections) covers every address in the workspace: an
 * owner or admin, an API key with manage on all domains, or an MCP approval with receiving consent, which reads with
 * read. A change (`change` says what, for the error) needs manage, receiving consent and a lasting credential.
 */
export function receivingAdmin(c: Ctx, change?: string): Actor {
  const refusal = receivingAdminRefusal(c.get('actor'), change);
  if (refusal) throw refusal;
  return c.get('actor');
}
/** Why receivingAdmin refuses this actor, or null. The MCP listing asks the same of receivingAdminRoute's operations. */
export function receivingAdminRefusal(a: Actor | undefined, change?: string): ApiError | null {
  const permission = !change && a?.receivingConsent ? 'read' : 'manage', need: Required = { permission: 'receivingRules', level: change ? 'write' : 'read' };
  if (!a || (!a.permissions.includes('manage') && !a.permissions.includes(permission))) return a?.credential === 'apiKey' ? missingPermission(a, permission, need) : denied('PERMISSION_DENIED', `This operation requires ${permission} permission.`, need);
  if (a.domains.length && a.credential === 'apiKey') return fullAccessRefusal('ADMIN_REQUIRED', a, 'Receiving configuration covers every address in the workspace, so it needs', { ...need, scope: 'workspace' });
  if (a.domains.length || a.role === 'member')
    return denied('ADMIN_REQUIRED', 'Receiving configuration covers every address in the workspace. Use an owner or admin session, or an API key with manage permission on all domains.', a.role === 'member' ? { ...need, person: 'admin' } : { ...need, scope: 'workspace' });
  if (!change) return null;
  if (a.grantId && !a.receivingConsent) return denied('ADMIN_REQUIRED', 'Changing receiving configuration requires an owner or admin of this workspace.', { ...need, person: 'admin' });
  return lastingRefusal(a, change, need);
}
/** Key administration (auth.ts manageKeys, and the deprecated inbound key routes): why it refuses this actor, or null.
 *  It takes unrestricted manage and a lasting credential that is not an agent's own setup key: an agent that received
 *  its key through agent setup can't make itself, or anyone, another API key or agent token. */
export function keyAdminRefusal(a: Actor): ApiError | null {
  const need: Required = { permission: 'configuration', level: 'write' };
  // An API key that isn't full access (onboarding's Send only key, most often): say which key it is and where keys are made.
  if (a.credential === 'apiKey' && (!a.permissions.includes('manage') || a.domains.length))
    return denied('PERMISSION_DENIED', `${credentialLimits(a).slice(0, -1)}, so it can't ${KEY_CHANGE}. Create keys in the dashboard under API keys → Create key, or with a full-access key via POST /v1/api-keys.`,
      a.permissions.includes('manage') ? { ...need, scope: 'workspace' } : need);
  if (!a.permissions.includes('manage')) return denied('PERMISSION_DENIED', 'This operation requires manage permission.', need);
  const temporary = lastingRefusal(a, KEY_CHANGE, need);
  if (temporary) return temporary;
  if (a.agentSetup) return denied('PERMISSION_DENIED', `A key an agent received at setup can't ${KEY_CHANGE}. An owner or admin does that in the dashboard (API keys).`, { ...need, person: 'admin' });
  if (a.domains.length) return denied('PERMISSION_DENIED', 'Key administration requires unrestricted management access.', { ...need, scope: 'workspace' });
  return null;
}
/** Billing (its balance, payments and top-ups): an agent's setup key never reaches it, reads included. REST refuses it in
 *  app.ts and the MCP listing leaves it out (mcp.ts refusal), with the same answer. */
/** agentSetupRefusal's credential routes: an inbox connection's key and a mail client password, which would outlive the
 *  agent's key when it is revoked. Inbox routes authenticate after the /v1 guard, so createInbox's own key (inboxes.ts,
 *  from its body) and app passwords (inbox-passwords.ts) are refused in their handlers too; this keeps the MCP listing. */
const agentCredentialRoute = (method: string, path: string) => method.toUpperCase() === 'POST' && (path === '/v1/inbox-connections' || /^\/v1\/inboxes\/[^/]+\/app-passwords$/.test(path));
export const agentCredentialRefusal = () => denied('PERMISSION_DENIED', 'A key an agent received at setup can\'t create inbox keys or mail client passwords: they would outlive it when it is revoked. An owner or admin does that in the dashboard.', { person: 'admin' });
export const agentSetupRefusal = (a: Actor | undefined, path: string, method = 'GET') => !a?.agentSetup ? null
  : /^\/v1\/billing(?:\/|$)/.test(path) ? denied('PERMISSION_DENIED', 'A key an agent received at setup can\'t read or change billing. An owner or admin does that in the dashboard (Settings → Billing).', { person: 'admin' })
  : agentCredentialRoute(method, path) ? agentCredentialRefusal() : null;
/** createAgentToken: only an MCP approval delegates a temporary token. Why it refuses this actor, or null. */
export const agentTokenMintRefusal = (a: Actor) => a.credential === 'mcp' && a.keyId.startsWith('mcp_') ? null
  : denied('MCP_AUTHORIZATION_REQUIRED', 'Temporary agent tokens can only be delegated directly from an MCP OAuth approval.', { credential: 'signIn' });
// ---------- route guards shared by REST and the MCP listing ----------
// Each takes a concrete request path or an OpenAPI template ({id} segments). The middleware that
// enforces a guard and the MCP listing that must agree with it call the same predicate.
/** mailboxAuth: inbox keys, or a workspace credential through actorMailAccess. */
export const mailboxRoute = (path: string) => /^\/v1\/(?:inbound|inboxes)(?:\/|$)/.test(path);
/** Only the inbox-filtered list uses mailbox authentication; the unfiltered list takes workspace credentials. */
export const filteredInboxPasswords = (c: Ctx) => c.req.path === '/v1/app-passwords' && (c.req.method === 'GET' || c.req.method === 'HEAD') && c.req.queries('inboxId') !== undefined;
const appPasswordRoute = (path: string) => /^\/v1\/(?:inboxes\/[^/]+\/)?app-passwords(?:\/|$)/.test(path);
/** requireReceivingConsent: an MCP grant without explicit receiving consent is refused. */
export const receivingConsentRoute = (path: string) =>
  appPasswordRoute(path) || /^\/v1\/(?:routing|rules|endpoints|inbound\/(?:retired|domains|addresses|webhooks|overview|endpoints))(?:\/|$)|^\/v1\/(?:inbox-connections|inbound\/policy|domains\/[^/]+\/receiving-host|inbound\/messages\/[^/]+\/redeliver)$/.test(path);
/** notMember: workspace members are refused these areas whatever their scopes. */
export const ownerRoute = (method: string, path: string) => {
  const verb = method.toUpperCase();
  return appPasswordRoute(path) || /^\/v1\/(?:domains|webhooks|agent-tokens)(?:\/|$)|^\/v1\/regions\/|^\/v1\/settings\/ses$/.test(path) || (path === '/v1/regions' && verb !== 'GET')
    || (verb === 'POST' && /^\/v1\/campaigns\/[^/]+\/(?:send|schedule|unschedule|reschedule|pause|resume|pacing|cancel)$/.test(path));
};
/** UNRESTRICTED_KEY_REQUIRED (app.ts): a sender-domain credential is refused these workspace-wide areas. Audience records
 *  have no sender domain, and a campaign's audience and delivery act on the workspace audience (a draft stays editable). */
export const unrestrictedRoute = (path: string) => /^\/v1\/(?:contacts|lists|newsletters|segments|topics|contact-imports|audience-query|settings|webhooks|metrics|sender-score|usage|billing|regions|app-passwords)(?:\/|$)/.test(path)
  || !['state', 'preview', 'preview-image', 'archive', undefined].includes(/^\/v1\/campaigns\/[^/]+\/([^/]+)$/.exec(path)?.[1]);
// The routes of the guards above that handlers call, for the MCP listing (each verified against REST's answers for reads).
/** receivingAdmin's routes: routing, rules, endpoints, inbox connections and an address's flow (its route and rule
 *  together). */
export const receivingAdminRoute = (path: string) => /^\/v1\/(?:routing|rules|endpoints|inbox-connections)(?:\/|$)|^\/v1\/inbound\/addresses\/[^/]+\/flow$/.test(path);
/** keyAdminRefusal's routes: API keys, and listing and revoking agent tokens. */
export const keyAdminRoute = (method: string, path: string) => /^\/v1\/(?:api-keys|agent-tokens)(?:\/|$)/.test(path) && !agentTokenMintRoute(method, path);
/** agentTokenMintRefusal's route: createAgentToken. */
export const agentTokenMintRoute = (method: string, path: string) => method.toUpperCase() === 'POST' && path === '/v1/agent-tokens';
/** lasting's other routes: setting up sending and receiving webhooks and reading their secrets, mail client passwords, and
 *  receiving hosts (adding, changing or removing one, choosing one, turning a domain's receiving on or off, its catch-all).
 *  Testing a webhook, retrying a delivery and checking a domain's MX stay a temporary token's. */
export function lastingRoute(method: string, path: string) {
  const verb = method.toUpperCase();
  return (verb === 'POST' && /^\/v1\/(?:inbound\/)?webhooks$/.test(path)) || ((verb === 'PATCH' || verb === 'DELETE') && /^\/v1\/(?:inbound\/)?webhooks\/[^/]+$/.test(path))
    || /^\/v1\/(?:inbound\/)?webhooks\/[^/]+\/(?:rotate-secret|secret)$/.test(path) || (verb !== 'GET' && /^\/v1\/inboxes\/[^/]+\/app-passwords(?:\/[^/]+)?$/.test(path))
    || (verb !== 'GET' && /^\/v1\/inbound\/domains\/[^/]+(?:\/(?:enable|disable|hosts(?:\/[^/]+)?|subdomains(?:\/[^/]+)?))?$/.test(path)) || (verb === 'POST' && /^\/v1\/domains\/[^/]+\/receiving-host$/.test(path));
}
/**
 * Members and invitations (listing members, and listing, creating and revoking invitations) and the workspace's
 * Activity: an owner or admin in person. That is a signed-in dashboard session, or their own MCP sign-in (a person's
 * approval, checked against their role now) with read to list members and invitations and manage to change them or to
 * read Activity, which names every member and credential. Never an API key, a key an approval made or a temporary agent
 * token: a membership outlasts every one of them. Why it refuses this actor, or null; the MCP listing asks the same of
 * memberAdminRoute's operations. Changing a member's role and removing a member stay with the dashboard (dashboardSession).
 */
export function memberAdminRefusal(a: Actor | undefined, change: boolean): ApiError | null {
  const signIn = a?.credential === 'mcp' && a.keyId.startsWith('mcp_'), need: Required = { person: 'admin' };
  if (!a || (a.credential !== 'dashboard' && !signIn)) return denied('DASHBOARD_AUTH_REQUIRED', 'Members, invitations and Activity are for an owner or admin in person: a signed-in dashboard session or their own MCP sign-in. API keys and agent tokens cannot.', need);
  if (a.role !== 'owner' && a.role !== 'admin') return denied('PERMISSION_DENIED', 'Workspace administration requires an owner or admin.', need);
  const permission = change ? 'manage' : 'read';
  if (signIn && !a.permissions.includes('manage') && !a.permissions.includes(permission)) return denied('PERMISSION_DENIED', `This operation requires ${permission} permission.`, { ...need, level: change ? 'write' : 'read' });
  return null;
}
/** memberAdminRefusal's routes: listing members, listing, creating and revoking invitations, and reading Activity. */
export const memberAdminRoute = (method: string, path: string) => path === '/v1/workspaces/current/invitations' || (method.toUpperCase() === 'GET' && (path === '/v1/workspaces/current/members' || path === '/v1/activity'));
/** Whether memberAdminRefusal asks a sign-in for manage here: every change, and reading Activity. */
export const memberAdminManage = (method: string, path: string) => method.toUpperCase() !== 'GET' || path === '/v1/activity';
/** notMember (app.ts): whether REST refuses this actor the route because it is a workspace member. */
export const memberRefused = (actor: Pick<Actor, 'role'> | undefined, method: string, path: string) => actor?.role === 'member' && ownerRoute(method, path);
/** Hosted workspace administration: a signed-in dashboard session, and with `manage` an owner or admin. Not found when self-hosted. */
export function dashboardSession(c: Ctx, manage = false) {
  if (!c.env.config.multiTenant) return notFound('Endpoint');
  const a = c.get('actor');
  if (a.credential !== 'dashboard') throw denied('DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.', { ...requiredOf(c), credential: 'dashboard' });
  if (manage && a.role !== 'admin' && a.role !== 'owner') throw denied('PERMISSION_DENIED', 'Workspace administration requires an owner or admin.', { ...requiredOf(c), person: 'admin' });
  return { workspaceId: a.workspaceId, userId: a.keyId.slice(5), email: a.email! };
}
/**
 * Whether a route's guard admits this caller. A summary reports a section as null when its own endpoint would refuse
 * the caller (403, 404) or isn't set up on this installation (a *_NOT_CONFIGURED error), instead of failing the whole read.
 */
export function admits(guard: () => unknown) {
  try { guard(); return true; }
  catch (error) { if (error instanceof ApiError && (error.status === 403 || error.status === 404 || error.code.endsWith('_NOT_CONFIGURED'))) return false; throw error; }
}
// Received mail a Nightmail credential can read: dashboard members read addressed mail; unrestricted manage credentials read
// the whole workspace; everything else reads none. Used by mailboxAuth, the unified logs and the MCP listing.
export function actorMailAccess(actor: Actor): MailboxAccess | null {
  if (actor.domains.length) return null;
  if (actor.role === 'member' && actor.credential === 'dashboard') return { keyId: actor.keyId, workspaceId: actor.workspaceId, admin: false, mailboxIds: null, permissions: ['read', 'send'] };
  if (!actor.permissions.includes('manage')) return null;
  return { keyId: actor.keyId, workspaceId: actor.workspaceId, admin: true, mailboxIds: null, permissions: ['read', 'send', 'modify'] };
}
/**
 * What mail a workspace credential reaches on a mailbox path (mailboxAuth), or why it reaches none. The MCP listing
 * asks the same question. A sender-domain credential never reaches mail; an unrestricted read API key reads inbound
 * webhook settings, not mail or delivery history.
 */
export function workspaceMailAccess(actor: Actor, method: string, path: string): MailboxAccess | 'UNRESTRICTED_KEY_REQUIRED' | 'ADMIN_REQUIRED' {
  if (actor.domains.length) return domainMailAccess(actor, method, path) ?? 'UNRESTRICTED_KEY_REQUIRED';
  if (!actor.permissions.includes('manage') && actor.credential === 'apiKey' && actor.permissions.includes('read') && method.toUpperCase() === 'GET' && /^\/v1\/inbound\/webhooks(?:\/[^/]+)?$/.test(path))
    return { keyId: actor.keyId, workspaceId: actor.workspaceId, admin: false, mailboxIds: null, permissions: [] };
  return actorMailAccess(actor) ?? 'ADMIN_REQUIRED';
}
/** The received-mail reads a key limited to sender domains may make: messages, their attachments, threads and events. */
const DOMAIN_MAIL_READS = /^\/v1\/inbound\/(?:messages(?:\/[^/]+(?:\/(?:attachments|parts)\/[^/]+)?)?|threads(?:\/[^/]+)?|events)$/;
/**
 * A workspace API key limited to sender domains that can read (read, or manage) reads the received mail addressed to
 * those domains, so "Read and Send limited to example.com" is a whole agent key: it sends from there and reads the replies.
 * Only those reads: everything else under /v1/inbound and /v1/inboxes stays a full-access key's (UNRESTRICTED_KEY_REQUIRED).
 * mailboxIds start empty, so the access reaches nothing until mailboxAuth puts the receiving addresses there in them.
 * A send-only key stays send-only; agent tokens and MCP sign-ins limited to domains read none.
 */
export function domainMailAccess(actor: Actor, method: string, path: string): MailboxAccess | null {
  if (actor.credential !== 'apiKey' || !actor.domains.length || (!actor.permissions.includes('read') && !actor.permissions.includes('manage'))) return null;
  if (method.toUpperCase() !== 'GET' || !DOMAIN_MAIL_READS.test(path)) return null;
  return { keyId: actor.keyId, workspaceId: actor.workspaceId, admin: false, mailboxIds: [], permissions: ['read'], domains: [...actor.domains] };
}
export function senderDomainAllowed(allowed: readonly string[], candidate: string) {
  const domain = candidate.toLowerCase();
  return !allowed.length || allowed.some(value => { const parent = value.toLowerCase(); return domain === parent || domain.endsWith(`.${parent}`); });
}
export const webhookUrlHint = (url: string) => '••••' + url.slice(-4);
export const WebhookUrlHint = z.string().describe('Write-only HTTPS endpoint. Only the last four characters are shown; omit url on update to keep the saved URL.');
