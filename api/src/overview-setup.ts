// GET /v1/overview/setup: what Overview's setup steps and next steps read, in one request instead of five (domains,
// API keys, any email, webhooks and invitations).
//
// Each section is answered exactly when its own endpoint would answer this caller: the same notMember path guard
// (memberRefused) and the same handler guard. A section the caller couldn't read there is null here. Beyond listDomains'
// own view, the sections are counts, so no webhook URL, key prefix, address or subject leaves through this route.
//
// Database budget after authentication, whatever the workspace holds, one statement at a time:
//   hosted: 2 (the domain page, then one statement with every count);
//   self-hosted: 4 (region settings, the domain page and its cached SES reports, then the counts).
import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { manageKeys } from './auth.js';
import { actor, admits, dashboardSession, memberRefused } from './core/access.js';
import { errors } from './core/errors.js';
import { response, security } from './core/http.js';
import type { App } from './core/types.js';
import { apiKeys } from './db/core.js';
import { webhooks } from './db/operations.js';
import { byoWorkspace } from './domain-claims.js';
import { emails } from './db/sending.js';
import { workspaceInvitations } from './db/workspaces.js';
import { DomainPage, domainPage, domainReader, workspaceActor } from './operations.js';
import { mailWhere } from './sending.js';
import { withRegionSettings } from './ses-region-state.js';

const Setup = z.object({
  domains: DomainPage.nullable().describe('The ten newest domains, exactly as listDomains with limit=10 and refresh=false returns them (continue there with nextCursor). Null when listDomains would refuse the caller, such as a member or a self-hosted installation without live SES.'),
  apiKeys: z.object({ active: z.number().int().describe('Unrevoked API keys.') }).nullable().describe('Null when listApiKeys would refuse the caller: it needs unrestricted manage, and agent tokens never list keys.'),
  emails: z.object({ any: z.boolean().describe('Whether any email the caller can read exists. Same scope as listEmails: a domain-restricted key sees only direct sends from its domains.') }),
  webhooks: z.object({ total: z.number().int().describe('Outbound webhooks, paused ones included.') }).nullable().describe('Null when listWebhooks would refuse the caller: members and domain-restricted keys.'),
  invitations: z.object({ pending: z.number().int().describe('Pending, unexpired invitations.') }).nullable().describe('Null unless listWorkspaceInvitations would answer: an owner or admin dashboard session on a hosted installation.'),
  progress: z.object({
    inbox: z.boolean().describe('An agent inbox exists.'),
    received: z.boolean().describe('Any email was received.'),
    contacts: z.boolean().describe('The audience has a contact.'),
    campaign: z.boolean().describe('A campaign exists, draft or not.'),
    campaignSent: z.boolean().describe('A campaign was launched (preparing, scheduled, sending, paused or done).'),
    newsletter: z.boolean().describe('A newsletter exists.'),
    readers: z.boolean().describe('A newsletter has a reader (a member of its list).'),
    issueSent: z.boolean().describe('A campaign to a newsletter was launched.'),
    agent: z.boolean().describe('An agent is connected: an unrevoked API key an agent setup made (the agent prompt\'s setup token or a device code), or a member\'s active MCP sign-in that defaults to this workspace or made agent tokens here.'),
  }).nullable().optional().describe('The first steps of each focus (focus in getWorkspaceSettings) and whether an agent is connected, as yes or no. Null unless the caller manages the whole workspace.'),
}).openapi('OverviewSetup');
type Counts = { api_keys: number | null; any_email: boolean; webhooks: number | null; invitations: number | null; domain_quota: { used: number; limit: number } | null; progress: z.infer<typeof Setup>['progress'] };
const LAUNCHED = sql`('preparing','scheduled','sending','paused','done')`;

export function registerOverviewSetup(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/overview/setup', operationId: 'getOverviewSetup', tags: ['Settings'], security,
    summary: 'Read the workspace setup',
    description: 'What this workspace has set up, in one read. The newest domains, the number of active API keys, outbound webhooks and pending invitations, whether any email exists, each focus\'s first steps and whether an agent is connected. Each part follows the permission rules of its own list operation and is null where that operation would refuse the caller. Counts only: no webhook URL, key, address or subject.',
    responses: { 200: response(Setup), ...errors } }), async c => {
    const a = actor(c), w = a.workspaceId;
    const readable = (path: string, guard: () => unknown) => !memberRefused(a, 'GET', path) && admits(guard);
    // An owner, an admin or an unrestricted manage key: whoever can set the workspace's focus.
    const progress = a.role !== 'member' && !a.domains.length && admits(() => workspaceActor(c, 'manage')), keys = readable('/v1/api-keys', () => manageKeys(c)), hooks = readable('/v1/webhooks', () => workspaceActor(c)), invites = readable('/v1/workspaces/current/invitations', () => dashboardSession(c, true));
    let domains: z.infer<typeof DomainPage> | null = null;
    if (!memberRefused(a, 'GET', '/v1/domains')) {
      // listDomains loads self-hosted region settings before its own guard (app.ts); hosted reads need none without a region.
      if (!c.env.config.multiTenant) c.env = await withRegionSettings(c.env, w);
      if (admits(() => domainReader(c))) domains = await domainPage(c, a, { limit: 10, refresh: 'false', countedElsewhere: true });
    }
    // listDomains' quota (hosted, unrestricted credentials), counted here so the read stays one statement of counts.
    const quota = domains !== null && c.env.config.multiTenant && !a.domains.length;
    const row = (await c.env.db.execute<Counts>(sql`/* overview-setup: counts */ SELECT
      ${quota ? sql`(SELECT json_build_object('used',count(*)::int,'limit',workspace_domain_limit(${w})) FROM domain_claims WHERE workspace_id=${w} AND NOT coalesce(identity ? 'builtin',false) HAVING NOT ${byoWorkspace(w)})` : sql`NULL::json`} AS domain_quota,
      ${keys ? sql`(SELECT count(*)::int FROM ${apiKeys} WHERE ${and(eq(apiKeys.workspaceId, w), isNull(apiKeys.revokedAt))} AND (${apiKeys.expiresAt} IS NULL OR ${apiKeys.expiresAt} > now()))` : sql`NULL::int`} AS api_keys,
      EXISTS (SELECT FROM ${emails} WHERE ${mailWhere(a)}) AS any_email,
      ${hooks ? sql`(SELECT count(*)::int FROM ${webhooks} WHERE ${eq(webhooks.workspaceId, w)})` : sql`NULL::int`} AS webhooks,
      ${invites ? sql`(SELECT count(*)::int FROM ${workspaceInvitations} WHERE ${and(eq(workspaceInvitations.workspaceId, w), eq(workspaceInvitations.status, 'pending'), gt(workspaceInvitations.expiresAt, sql`now()`))})` : sql`NULL::int`} AS invitations,
      ${progress ? sql`json_build_object(
        'inbox',EXISTS (SELECT FROM mailboxes WHERE workspace_id=${w} AND kind='inbox'),
        'received',EXISTS (SELECT FROM mail_messages WHERE workspace_id=${w} AND direction='inbound'),
        'contacts',EXISTS (SELECT FROM audience_contacts WHERE workspace_id=${w}),
        'campaign',EXISTS (SELECT FROM sending_campaigns WHERE workspace_id=${w}),
        'campaignSent',EXISTS (SELECT FROM sending_campaigns WHERE workspace_id=${w} AND state IN ${LAUNCHED}),
        'newsletter',EXISTS (SELECT FROM audience_lists WHERE workspace_id=${w} AND newsletter_from IS NOT NULL),
        'readers',EXISTS (SELECT FROM audience_lists l JOIN audience_list_members m ON m.workspace_id=l.workspace_id AND m.list_id=l.id WHERE l.workspace_id=${w} AND l.newsletter_from IS NOT NULL),
        'issueSent',EXISTS (SELECT FROM sending_campaigns c JOIN audience_lists l ON l.workspace_id=c.workspace_id AND l.id=c.list_id WHERE c.workspace_id=${w} AND l.newsletter_from IS NOT NULL AND c.state IN ${LAUNCHED}),
        'agent',EXISTS (SELECT FROM ${apiKeys} WHERE ${and(eq(apiKeys.workspaceId, w), isNull(apiKeys.revokedAt))} AND ${apiKeys.agentSetupId} IS NOT NULL AND (${apiKeys.expiresAt} IS NULL OR ${apiKeys.expiresAt} > now()))
          OR EXISTS (SELECT FROM workspace_members m JOIN nightmail_resource_grants g ON g.user_id=m.user_id WHERE m.workspace_id=${w} AND NOT g.revoked
            AND (g.workspace_id=${w} OR EXISTS (SELECT FROM agent_tokens t WHERE t.workspace_id=${w} AND t.grant_id=g.id))))` : sql`NULL::json`} AS progress`)).rows[0]!;
    if (domains && row.domain_quota) domains = { ...domains, quota: row.domain_quota };
    return c.json({ domains, apiKeys: row.api_keys === null ? null : { active: row.api_keys }, emails: { any: row.any_email },
      webhooks: row.webhooks === null ? null : { total: row.webhooks }, invitations: row.invitations === null ? null : { pending: row.invitations }, progress: row.progress ?? null }, 200);
  });
}
