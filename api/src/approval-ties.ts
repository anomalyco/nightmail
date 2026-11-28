import { z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import type { Config, Runtime } from './core/types.js';
import { receivingPolicy } from './mailbox-ingest-input.js';

// What an MCP approval made or changed is tied to it (mail_grant_objects): a key it created works, and a webhook it set
// up or changed delivers, only while the approval is active, and removing the approval revokes the key and holds the
// webhook. A webhook or endpoint that several approvals changed has several owners, and needs every one of them.
// Active is nightmail_approval_active (migration 341): not removed, its agent connected within 30 days and at most 90
// days after the person approved it, and its person still an owner or admin here.
export type TiedKind = 'api_key' | 'key' | 'webhook' | 'endpoint';

/**
 * The rule a tied object is used by: every approval that owns it is active (mail_key_grant_allows, which checks each
 * owner with mail_management_grant). An object nobody owns passes. A sending webhook's delivery, a send by a tied key
 * and the approval state the API reports all read this, so what is reported is what is enforced.
 */
export const tieAllows = (config: Config, w: SQL | string, resource: SQL | string, kind: SQL | TiedKind) =>
  sql`mail_key_grant_allows(${w}, ${resource}, ${kind}, ${receivingPolicy(config)}::jsonb)`;

const Owner = z.object({
  id: z.string().describe('An agent sign-in (mcp_…) that owns it, as listAgents lists it.'),
  endsAt: z.string().describe('When this approval ends: 30 days after its agent last connected, and no later than 90 days after the person approved the agent. Each connection moves it later, up to that limit; removing the approval ends it at once.'),
  active: z.boolean().describe('This approval is active: not revoked or ended, with the manage scope, and its person an owner or admin here.'),
}).openapi('ApprovalOwner');
export const ApprovalTie = z.object({
  active: z.boolean().describe('Every approval that owns it is active, so a key is accepted and a webhook is delivered to. False: a key is refused and a webhook is not delivered to until all of them are active again.'),
  endsAt: z.string().describe('The earliest end among its owners: when it stops working unless their agents connect again before then.'),
  owners: z.array(Owner).min(1).describe('Each approval that owns it, by ID. A key has one; a webhook has one for each approval that set it up or changed it.'),
}).openapi('ApprovalTie');
export const approvalField = ApprovalTie.nullable().describe('Set when this is tied to MCP approvals: created, or for a webhook set up or changed, over MCP with a person’s sign-in or with a key that is tied. It works only while every one of them is active. Null: it lasts, not tied to any approval.');
export type Tie = z.infer<typeof ApprovalTie>;

/** The ties of the given objects in one workspace, by object ID. Untied objects are missing. */
export async function approvalTies(runtime: Runtime, w: string, kinds: TiedKind[], ids: string[]): Promise<Map<string, Tie>> {
  if (!ids.length) return new Map();
  const { rows } = await runtime.db.execute<{ resource: string; active: boolean; ends_at: string; owners: { id: string; endsAt: string; active: boolean }[] }>(sql`
    SELECT o.resource, ${tieAllows(runtime.config, sql`o.workspace_id`, sql`o.resource`, sql`o.kind`)} AS active, to_jsonb(min(nightmail_approval_ends(g))) #>> '{}' AS ends_at,
      jsonb_agg(jsonb_build_object('id', g.id, 'endsAt', nightmail_approval_ends(g), 'active', mail_management_grant(o.workspace_id, o.grant_id, ${receivingPolicy(runtime.config)}::jsonb, false)) ORDER BY g.id) AS owners
    FROM mail_grant_objects o JOIN nightmail_resource_grants g ON g.grant_key = o.grant_id
    WHERE o.workspace_id = ${w} AND o.kind = ANY(${sql.param(kinds)}::text[]) AND o.resource = ANY(${sql.param(ids)}::text[])
    GROUP BY o.workspace_id, o.kind, o.resource`);
  const iso = (value: string) => new Date(value).toISOString();
  return new Map(rows.map(r => [r.resource, { active: r.active, endsAt: iso(r.ends_at), owners: r.owners.map(o => ({ id: o.id, endsAt: iso(o.endsAt), active: o.active })) }]));
}
export const approvalTie = async (runtime: Runtime, w: string, kinds: TiedKind[], id: string) => (await approvalTies(runtime, w, kinds, [id])).get(id) ?? null;

/** The create result's nextStep for a tied object: what it depends on, until when, and how to make a lasting one. */
export const tiedNextStep = (what: 'key' | 'webhook', tie: Tie) =>
  `This ${what} is tied to the MCP approval ${tie.owners.map(o => o.id).join(' and ')}: it ${what === 'key' ? 'works' : 'delivers'} only while that approval is active (now until ${tie.endsAt}: 30 days after the agent last connected, at most 90 days after you approved it), and revoking the approval ${what === 'key' ? 'revokes the key' : 'pauses the webhook until its URL is sent again'}. For a lasting ${what}, create it in the dashboard or with a workspace API key with manage that was not created over MCP.`;
