import { request, type RequestScope } from './live'
import { productName } from '../../../api/src/brand'

// Settings → Activity (hosted, owners and admins): GET /v1/activity, the workspace's audit trail, newest first.
import type { AuditActorType, AuditEntry } from './types'
export type { AuditActorType, AuditEntry }
export type ActivityPage = { data: AuditEntry[]; nextCursor: string | null }
export type ActivityFilters = { action?: string; actorType?: AuditActorType; since?: string; until?: string }

export const activityApi = (scope: RequestScope | 'unscoped') => ({
  list: (filters: ActivityFilters & { cursor?: string; limit?: number }, signal?: AbortSignal) => {
    const params = new URLSearchParams({ limit: String(filters.limit ?? 50) })
    for (const key of ['cursor', 'action', 'actorType', 'since', 'until'] as const) if (filters[key]) params.set(key, filters[key]!)
    return request<ActivityPage>(`/v1/activity?${params}`, { signal, scope })
  },
})

// What each action reads as. An action not listed here (a newer API) shows its raw name.
const labels: Record<string, string> = {
  'member.invite': 'Invited a member', 'member.invite_revoke': 'Revoked an invitation', 'member.join': 'Joined the workspace', 'member.role_change': 'Changed a member’s role', 'member.remove': 'Removed a member',
  'workspace.create': 'Created the workspace', 'workspace.rename': 'Renamed the workspace', 'settings.update': 'Updated settings', 'settings.inbound_policy': 'Changed the inbound policy',
  'api_key.create': 'Created an API key', 'api_key.update': 'Changed an API key', 'api_key.revoke': 'Revoked an API key',
  'agent_token.create': 'Created an agent token', 'agent_token.revoke': 'Revoked an agent token', 'mcp_connection.revoke': 'Revoked an agent', 'mcp_connection.bind': 'Set an agent’s default workspace',
  'inbox_key.create': 'Created an API key', 'inbox_key.revoke': 'Revoked an API key', 'inbox_connection.create': 'Connected an agent to inboxes', 'app_password.create': 'Created an app password', 'app_password.revoke': 'Revoked an app password',
  'domain.create': 'Added a domain', 'domain.delete': 'Deleted a domain', 'domain.mail_from': 'Set a MAIL FROM domain', 'domain.mail_from_remove': 'Removed a MAIL FROM domain', 'domain.receiving_host': 'Chose a receiving host',
  'inbound_domain.enable': 'Turned on receiving', 'inbound_domain.disable': 'Turned off receiving', 'inbound_domain.update': 'Updated a receiving domain',
  'inbound_host.create': 'Added a receiving host', 'inbound_host.update': 'Updated a receiving host', 'inbound_host.delete': 'Removed a receiving host', 'inbound_subdomain.create': 'Added a receiving subdomain', 'inbound_subdomain.update': 'Updated a receiving subdomain', 'inbound_subdomain.delete': 'Deleted a receiving subdomain',
  'address.create': 'Created an address', 'address.update': 'Updated an address', 'address.delete': 'Deleted an address', 'address.release': 'Released an address',
  'inbox.create': 'Created an inbox', 'inbox.update': 'Updated an inbox', 'inbox.delete': 'Deleted an inbox',
  'webhook.create': 'Added a webhook', 'webhook.update': 'Updated a webhook', 'webhook.delete': 'Deleted a webhook', 'webhook.secret_reveal': 'Revealed a signing secret', 'webhook.secret_rotate': 'Rotated a signing secret',
  'inbound_webhook.create': 'Added an inbound webhook', 'inbound_webhook.update': 'Updated an inbound webhook', 'inbound_webhook.delete': 'Deleted an inbound webhook', 'inbound_webhook.secret_rotate': 'Rotated an inbound signing secret',
  'endpoint.create': 'Added an endpoint', 'endpoint.update': 'Updated an endpoint', 'endpoint.delete': 'Deleted an endpoint',
  // Rule actions keep the ritual. IDs from before rituals were renamed rules: they name stored audit events.
  'ritual.save': 'Saved a rule', 'ritual.delete': 'Deleted a rule', 'ritual.apply': 'Applied rules', 'ritual.attach': 'Attached a rule', 'ritual.restore': 'Restored rules', 'ritual.omens': 'Changed where AI decisions read mail', 'ritual.recipe': 'Saved a rule from a recipe', 'ritual.enable': 'Turned on a rule', 'ritual.disable': 'Turned off a rule',
  'routing.apply': 'Applied routing', 'routing.restore': 'Restored routing', 'route.create': 'Added a route', 'route.update': 'Updated a route', 'route.delete': 'Deleted a route',
  'connection.create': 'Connected sending', 'connection.delete': 'Disconnected sending', 'connection.verify': 'Verified the sending connection', 'connection.production_access': 'Requested SES production access', 'connection.cleanup': 'Left AWS resources after disconnecting',
  'region.configure': 'Configured a region', 'region.provision': 'Provisioned a region', 'region.auto_validation': 'Changed auto-validation',
  'campaign.pause': 'Paused a campaign', 'campaign.resume': 'Resumed a campaign', 'campaign.cancel': 'Cancelled a campaign', 'audience.bulk_apply': 'Changed contacts in bulk',
  'sending.pause': 'Paused sending', 'sending.resume': 'Resumed sending',
  'support.contact': 'You contacted support', 'support.view': 'Viewed this workspace',
  'billing.topup': 'Added credit', 'billing.grant': `Promotional credit from ${productName}`, 'billing.adjustment': `Adjustment by ${productName}`, 'billing.refund_release': 'Refund canceled: credit restored',
  'billing.dispute': 'Card payment disputed', 'billing.dispute_reversal': 'Dispute closed: credit restored', 'billing.write_off': 'Unpaid balance written off', 'billing.expire': 'Credit expired',
}
export const actionLabel = (action: string) => labels[action] ?? action
// The area filter: each option is one action prefix, which the API takes as `action=<area>.`.
export const activityAreas: { value: string; label: string }[] = [
  ['member.', 'Members'], ['workspace.', 'Workspace'], ['settings.', 'Settings'], ['api_key.', 'API keys'], ['agent_token.', 'Agent tokens'], ['inbox_key.', 'API keys (earlier)'], ['app_password.', 'App passwords'],
  ['domain.', 'Domains'], ['inbound_domain.', 'Receiving domains'], ['address.', 'Addresses'], ['inbox.', 'Inboxes'], ['webhook.', 'Webhooks'], ['inbound_webhook.', 'Inbound webhooks'],
  ['endpoint.', 'Endpoints'], ['route.', 'Routes'], ['ritual.', 'Rules'], ['connection.', 'Sending connection'], ['campaign.', 'Campaigns'], ['billing.', 'Billing'], ['support.', 'Support'],
].map(([value, label]) => ({ value, label }))
