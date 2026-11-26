import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, inArray, sql } from 'drizzle-orm';
import { errors, isoTime, response, wrapModuleLoad, type App, type DbExecutor } from './core.js';
import { mailboxDomains } from './db/mailbox.js';
import { supportRead } from './deliverability.js';
import { hostGraceStart, receivingSetup, setupError, type ReceivingSetup } from './states.js';
import { narrowed, type SupportMeta } from './support-deliverability.js';

// A support conversation's receiving reads: GET only, behind supportGate like every /v1/support route (charged, on the
// audit trail, hidden from the OpenAPI document), each over the conversation's workspaces whose role reads the dashboard's
// counterpart (owners and admins: SUPPORT_CEILINGS), narrowed by workspaceId. Each is one budgeted read (supportRead):
// - hosts: every receiving host with its state and its last MX check (what Receiving → Domains shows);
// - routes: where received mail goes, and each destination's last 7 days of deliveries;
// - retired: addresses still held after their inbox was deleted, and when each frees;
// - forwards: forward confirmations emailed to a recipient and not yet confirmed.
// Never message content, a webhook's URL or a forward's whole address (its domain only). Route notes and patterns, names
// and DNS diagnostics are the customer's or other people's text: the support Worker fences them (projection.ts UNTRUSTED).

const ids = (list: string[]) => sql`${sql.param(list)}::text[]`;
/** At most this many of each list; `truncated` says when there were more. */
const HOSTS = 100, ROUTES = 50, DESTINATIONS = 100, HELD = 100, FORWARDS = 50;
/** Deliveries counted per destination in the 7-day window (more are counted as this many). */
const TALLY = 5000;

export function registerSupportReceiving(app: App, meta: SupportMeta, WorkspaceFilter: z.ZodObject<{ workspaceId: z.ZodOptional<z.ZodString> }>) {
  // ---------- hosts ----------
  const Host = z.object({
    workspaceId: z.string(), domainId: z.string(), domain: z.string().describe('The domain the host receives for.'), id: z.string(), host: z.string().describe('The name its MX record is on.'),
    status: z.enum(['pending', 'active', 'mixed', 'lost', 'failed', 'removed']).describe('pending until its MX is seen; active; mixed: beside another provider’s MX; lost: its MX disappeared (receiving stops when the two-hour grace ends); failed: receiving setup gave up; removed.'),
    catchAll: z.string().describe('create_address: an unknown recipient becomes an address; store: kept as unrouted mail.'),
    expectedMx: z.record(z.string(), z.unknown()).describe('The MX record to publish.'),
    mx: z.record(z.string(), z.unknown()).nullable().describe('The last MX check: its state (active, missing, conflict, mixed, wrong_region, null_mx, cname, error), the records and providers found, a message and checkedAt.'),
    lastCheckedAt: z.string().nullable().describe('When its DNS was last checked.'), lostSince: z.string().nullable().describe('When its MX went missing (lost), else null.'),
    issue: z.record(z.string(), z.unknown()).nullable().describe('What needs the owner’s attention in DNS: a code, whether it blocks receiving, and a message.'), lastError: z.string().nullable(),
    addressCount: z.number(), enabledAt: z.string().nullable(), createdAt: z.string(),
  }).openapi('SupportReceivingHost');
  app.openapi(createRoute({ ...meta('listSupportReceivingHosts', 'Every receiving host of the customer’s domains (owner and admin workspaces) with its state, the MX record it needs, its last MX check and when it was checked, any DNS issue, its catch-all and how many addresses it has.'),
    path: '/v1/support/receiving/hosts', request: { query: WorkspaceFilter }, responses: { 200: response(z.object({ data: z.array(Host), truncated: z.boolean() })), ...errors } }), async c => {
    const list = narrowed(c);
    if (!list.length) return c.json({ data: [], truncated: false }, 200);
    const { hostView } = await wrapModuleLoad(() => import('./receiving-hosts.js'));
    type Claim = { id: string; name: string; receiving_state: 'off' | 'pending' | 'active' | 'lost'; receiving_host: string | null; receiving_lost_since: string | null; identity: { issue?: unknown } | null; receiving_setup: ReceivingSetup | null; claimed: boolean };
    const { rows, claims, counts } = await supportRead(c.env.db, async tx => {
      // A test (sandbox) domain never receives: left out.
      const rows = await tx.select().from(mailboxDomains).where(and(inArray(mailboxDomains.workspaceId, list), sql`${mailboxDomains.name} NOT LIKE '%.sandbox.invalid'`))
        .orderBy(asc(mailboxDomains.workspaceId), sql`${mailboxDomains.parentId} IS NOT NULL`, asc(mailboxDomains.createdAt), asc(mailboxDomains.id)).limit(HOSTS + 1);
      // A host's domain is its own row's (the row without a parent): every host below it receives for the same domain.
      const domainIds = [...new Set(rows.map(row => row.domainId))];
      const claims = domainIds.length ? (await tx.execute<Claim>(sql`SELECT d.id, d.name, dc.receiving_state, dc.receiving_host, dc.receiving_lost_since::text, jsonb_build_object('issue', dc.identity -> 'issue') AS identity,
          ${receivingSetup()} AS receiving_setup, dc.workspace_id IS NOT NULL AS claimed
        FROM operation_domains d LEFT JOIN domain_claims dc ON dc.workspace_id = d.workspace_id AND dc.name = d.name WHERE d.workspace_id = ANY(${ids(list)}) AND d.id = ANY(${ids(domainIds)})`)).rows : [];
      const counts = rows.length ? (await tx.execute<{ id: string; n: number }>(sql`SELECT domain_id AS id, count(*)::int AS n FROM mailboxes WHERE workspace_id = ANY(${ids(list)}) AND domain_id = ANY(${ids(rows.map(row => row.id))}) GROUP BY 1`)).rows : [];
      return { rows, claims, counts };
    });
    const data = rows.slice(0, HOSTS).map(row => {
      const own = (row.parentId && rows.find(r => r.id === row.parentId)) || row, found = claims.find(x => x.id === own.domainId), claim = found?.claimed ? found : null;
      const view = hostView(row, counts.find(x => x.id === row.id)?.n ?? 0, claim as Parameters<typeof hostView>[2]), setup = claim?.receiving_setup;
      const lostSince = view.status === 'lost' ? (claim ? hostGraceStart(claim, { host: view.name, lost_since: isoTime(row.lostSince) }) : row.lostSince) : null;
      return { workspaceId: row.workspaceId, domainId: own.domainId, domain: found?.name ?? own.name, id: row.id, host: view.name, status: view.status, catchAll: view.catchAll, expectedMx: view.dns[0]!,
        mx: view.mx, lastCheckedAt: isoTime(row.checkedAt), lostSince: isoTime(lostSince), issue: view.issue, lastError: row.lastError ?? (view.status === 'failed' && setup?.status === 'failed' ? setupError(setup) : null),
        addressCount: view.addressCount, enabledAt: isoTime(row.enabledAt), createdAt: view.createdAt };
    });
    return c.json({ data, truncated: rows.length > HOSTS }, 200);
  });

  // ---------- routes and their deliveries ----------
  const Tally = z.object({ delivered: z.number(), failed: z.number(), pending: z.number(), paused: z.number() });
  const Destination = z.object({
    workspaceId: z.string(), id: z.string(), type: z.enum(['inbox', 'webhook', 'forward', 'slack', 'discord', 'unknown']), name: z.string().nullable().describe('An inbox’s address, or an endpoint’s name.'),
    state: z.string().describe('An inbox: active or deleting. An endpoint: ready, pending (a forward waiting for its recipient), expired, declined or paused. unknown: no longer exists.'),
    last7d: Tally.nullable().describe('An endpoint’s deliveries created in the last 7 days, by status.'),
    lastFailure: z.object({ at: z.string(), lastStatusCode: z.number().nullable(), lastError: z.string().nullable(), attempts: z.number() }).nullable().describe('An endpoint’s latest failed delivery in the last 7 days.'),
    stored: z.object({ messages: z.number(), held: z.number(), heldSince: z.string().nullable() }).nullable().describe('An inbox’s stored mail, and how much is held (over its quota or after it expired).'),
  }).openapi('SupportRouteDestination');
  const Route = z.object({
    workspaceId: z.string(), id: z.string(), key: z.string().nullable(), match: z.string().describe('The recipient pattern it matches.'), to: z.unknown().describe('Destination IDs, [] to keep mail stored, or "drop".'),
    subaddresses: z.boolean(), enabled: z.boolean(), note: z.string(), createdAt: z.string(),
  }).openapi('SupportRoute');
  app.openapi(createRoute({ ...meta('listSupportRoutes', 'Where received mail goes: the receiving routes of the customer’s owner and admin workspaces (at most 50, by recipient pattern), and each destination with its state and results: an endpoint’s (webhook, forward, Slack or Discord) deliveries of the last 7 days by status and its latest failure, an inbox’s stored and held mail.'),
    path: '/v1/support/receiving/routes', request: { query: WorkspaceFilter }, responses: { 200: response(z.object({ data: z.array(Route), destinations: z.array(Destination), truncated: z.boolean() })), ...errors } }), async c => {
    const list = narrowed(c);
    if (!list.length) return c.json({ data: [], destinations: [], truncated: false }, 200);
    const result = await supportRead(c.env.db, async tx => {
      const routes = (await tx.execute<z.infer<typeof Route>>(sql`SELECT workspace_id AS "workspaceId", id, key, match, destinations AS "to", subaddresses, enabled, note, created_at::text AS "createdAt"
        FROM mail_routes WHERE workspace_id = ANY(${ids(list)}) ORDER BY workspace_id, match LIMIT ${ROUTES + 1}`)).rows;
      const all = [...new Set(routes.slice(0, ROUTES).flatMap(r => Array.isArray(r.to) ? r.to.filter((d): d is string => typeof d === 'string') : []))], named = all.slice(0, DESTINATIONS);
      return { routes, named, more: all.length > DESTINATIONS, destinations: named.length ? await destinations(tx, list, named) : [] };
    });
    const found = new Map(result.destinations.map(d => [d.id, d]));
    const destinationsOf = result.named.map(id => found.get(id) ?? { workspaceId: '', id, type: 'unknown' as const, name: null, state: 'unknown', last7d: null, lastFailure: null, stored: null });
    return c.json({ data: result.routes.slice(0, ROUTES).map(r => ({ ...r, createdAt: isoTime(r.createdAt)! })), destinations: destinationsOf, truncated: result.routes.length > ROUTES || result.more }, 200);
  });

  // ---------- addresses held after a deletion ----------
  const Held = z.object({
    workspaceId: z.string(), address: z.string(),
    state: z.enum(['retired', 'deleting']).describe('retired: its inbox was deleted and the address is held until freesAt (an owner or admin can release it sooner); deleting: its inbox was deleted at deletedAt and its mail is being erased (hourly), after which a test (sandbox) address is held 30 more days.'),
    deletedAt: z.string().nullable(), freesAt: z.string().nullable(),
  }).openapi('SupportHeldAddress');
  app.openapi(createRoute({ ...meta('listSupportHeldAddresses', 'Addresses of deleted inboxes that are still held, so they can’t be created again yet (409 ADDRESS_RETIRED), with when each frees: at most 100, soonest first.'),
    path: '/v1/support/receiving/retired', request: { query: WorkspaceFilter }, responses: { 200: response(z.object({ data: z.array(Held), truncated: z.boolean() })), ...errors } }), async c => {
    const list = narrowed(c);
    if (!list.length) return c.json({ data: [], truncated: false }, 200);
    const rows = await supportRead(c.env.db, async tx => (await tx.execute<z.infer<typeof Held>>(sql`SELECT "workspaceId", address, state, "deletedAt"::text, "freesAt"::text FROM (
        SELECT workspace_id AS "workspaceId", address, 'retired' AS state, NULL::timestamptz AS "deletedAt", until AS "freesAt" FROM mail_retired_addresses WHERE workspace_id = ANY(${ids(list)}) AND until > now()
        UNION ALL SELECT b.workspace_id, a.address, 'deleting', b.delete_after, NULL FROM mailboxes b JOIN mailbox_addresses a ON a.workspace_id = b.workspace_id AND a.mailbox_id = b.id
          WHERE b.workspace_id = ANY(${ids(list)}) AND b.delete_after <= now()
      ) x ORDER BY "freesAt" NULLS FIRST, "deletedAt", address LIMIT ${HELD + 1}`)).rows);
    return c.json({ data: rows.slice(0, HELD).map(r => ({ ...r, deletedAt: isoTime(r.deletedAt), freesAt: isoTime(r.freesAt) })), truncated: rows.length > HELD }, 200);
  });

  // ---------- forward confirmations waiting ----------
  const Forward = z.object({
    workspaceId: z.string(), id: z.string(), name: z.string().nullable().describe('The forward endpoint’s name.'), recipientDomain: z.string().nullable().describe('The domain of the address it forwards to (never the whole address).'),
    status: z.enum(['pending', 'expired', 'declined', 'paused']).describe('pending: the confirmation email was sent and its link is still open; expired: its 24-hour link lapsed (create the forward again to resend it); declined: the recipient declined, and this workspace can’t ask them again for 30 days; paused: deliveries are held.'),
    requestedFrom: z.string().nullable().describe('The workspace’s address the confirmation was sent from.'), requestedAt: z.string().nullable(), expiresAt: z.string().nullable(), declinedAt: z.string().nullable(),
  }).openapi('SupportPendingForward');
  app.openapi(createRoute({ ...meta('listSupportPendingForwards', 'Forward endpoints whose recipient hasn’t confirmed: the confirmation email Nightmail sent (from which address, when) and whether its link is still open, lapsed or was declined. At most 50, newest first.'),
    path: '/v1/support/receiving/forwards', request: { query: WorkspaceFilter }, responses: { 200: response(z.object({ data: z.array(Forward), truncated: z.boolean() })), ...errors } }), async c => {
    const list = narrowed(c);
    if (!list.length) return c.json({ data: [], truncated: false }, 200);
    // endpointStatus (src/endpoints.ts), for a forward its recipient hasn't confirmed.
    const rows = await supportRead(c.env.db, async tx => (await tx.execute<z.infer<typeof Forward> & { target: string | null }>(sql`SELECT workspace_id AS "workspaceId", id, key AS name, encrypted_target AS target,
        CASE WHEN paused THEN 'paused' WHEN declined_at IS NOT NULL THEN 'declined' WHEN expires_at <= now() THEN 'expired' ELSE 'pending' END AS status,
        request_from AS "requestedFrom", requested_at::text AS "requestedAt", expires_at::text AS "expiresAt", declined_at::text AS "declinedAt"
      FROM mailbox_webhooks WHERE workspace_id = ANY(${ids(list)}) AND type = 'forward' AND NOT verified ORDER BY requested_at DESC NULLS LAST, id LIMIT ${FORWARDS + 1}`)).rows);
    const { decrypt } = await wrapModuleLoad(() => import('./operations.js'));
    const domainOf = async (r: { workspaceId: string; id: string; target: string | null }) => {
      if (!r.target) return null;
      try { const address = await decrypt(c.env, r.target, `${r.workspaceId}:endpoint:${r.id}`); return address.slice(address.lastIndexOf('@') + 1).toLowerCase() || null; } catch { return null; }
    };
    const data = await Promise.all(rows.slice(0, FORWARDS).map(async ({ target, ...r }) => ({ ...r, recipientDomain: await domainOf({ ...r, target }),
      requestedAt: isoTime(r.requestedAt), expiresAt: isoTime(r.expiresAt), declinedAt: isoTime(r.declinedAt) })));
    return c.json({ data, truncated: rows.length > FORWARDS }, 200);
  });
}

/** Route destinations by ID, within the conversation's workspaces: endpoints with their 7-day deliveries, inboxes with their stored mail. */
async function destinations(tx: DbExecutor, list: string[], named: string[]) {
  type Row = { workspaceId: string; id: string; type: string; name: string | null; state: string; last7d: Record<string, number> | null; lastFailure: { at: string; lastStatusCode: number | null; lastError: string | null; attempts: number } | null;
    stored: { messages: number; held: number; heldSince: string | null } | null };
  const { rows } = await tx.execute<Row>(sql`SELECT h.workspace_id AS "workspaceId", h.id, h.type, coalesce(h.key, h.name) AS name,
      CASE WHEN h.paused THEN 'paused' WHEN h.declined_at IS NOT NULL THEN 'declined' WHEN h.verified THEN 'ready' WHEN h.expires_at <= now() THEN 'expired' ELSE 'pending' END AS state,
      (SELECT jsonb_build_object('delivered', count(*) FILTER (WHERE status = 'delivered'), 'failed', count(*) FILTER (WHERE status = 'failed'), 'pending', count(*) FILTER (WHERE status = 'pending'),
        'paused', count(*) FILTER (WHERE status = 'paused')) FROM (SELECT status FROM mailbox_webhook_deliveries d WHERE d.webhook_id = h.id AND d.workspace_id = h.workspace_id
          AND d.created_at > now() - interval '7 days' LIMIT ${TALLY}) x) AS last7d,
      (SELECT jsonb_build_object('at', d.updated_at, 'lastStatusCode', d.last_status_code, 'lastError', left(d.last_error, 300), 'attempts', d.attempt_count) FROM mailbox_webhook_deliveries d
        WHERE d.webhook_id = h.id AND d.workspace_id = h.workspace_id AND d.status = 'failed' AND d.created_at > now() - interval '7 days' ORDER BY d.created_at DESC, d.id DESC LIMIT 1) AS "lastFailure",
      NULL::jsonb AS stored
    FROM mailbox_webhooks h WHERE h.workspace_id = ANY(${sql.param(list)}::text[]) AND h.id = ANY(${sql.param(named)}::text[])
    UNION ALL SELECT b.workspace_id, b.id, 'inbox', b.address, CASE WHEN b.delete_after <= now() THEN 'deleting' ELSE 'active' END, NULL, NULL,
      jsonb_build_object('messages', coalesce(s.messages, 0), 'held', coalesce(s.held, 0), 'heldSince', s.held_since)
    FROM mailboxes b LEFT JOIN inbox_state s ON s.inbox_id = b.id WHERE b.workspace_id = ANY(${sql.param(list)}::text[]) AND b.id = ANY(${sql.param(named)}::text[])`);
  return rows.map(r => ({ ...r, type: (['inbox', 'webhook', 'forward', 'slack', 'discord'].includes(r.type) ? r.type : 'unknown') as 'inbox' | 'webhook' | 'forward' | 'slack' | 'discord' | 'unknown',
    last7d: r.last7d ? { delivered: Number(r.last7d.delivered ?? 0), failed: Number(r.last7d.failed ?? 0), pending: Number(r.last7d.pending ?? 0), paused: Number(r.last7d.paused ?? 0) } : null,
    lastFailure: r.lastFailure ? { ...r.lastFailure, at: isoTime(r.lastFailure.at)! } : null, stored: r.stored ? { ...r.stored, heldSince: isoTime(r.stored.heldSince) } : null }));
}
