import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { retainedMail } from './db/mailbox.js';
import { actor, ApiError, budgetedRead, denied, errors, id, json, readLimit, readLimitNote, receivingAdmin, response, security, type App, type Ctx, type DbExecutor, type Runtime } from './core.js';
import { PAGE_MAX_BYTES, utf8Bytes, withBoundedRead } from './read-bounds.js';
import { fitPageByBytes, ROUTING_CONFIG_MAX_BYTES } from './inbound-bounds.js';
import { auditContext, auditInsert } from './audit.js';
import { receivingPolicy } from './mailbox-ingest-input.js';
import { PARSE_LIMIT } from './mailbox-mime.js';
import { ADDRESS, lockMailboxLane } from './mailbox-store.js';
import { matchRouting, ROUTE_TIERS, type RoutingInput } from './routing-match.js';

export const RoutingKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
  .describe('Stable key you choose (lowercase letters, digits, hyphens). Config files refer to inbox:<key>, webhook:<key> and forward:<name>.');
const Address = z.string().trim().toLowerCase().max(254);
// A forward is the second alternative, so a client written for inboxes and webhooks keeps validating against the first.
const Destination = z.union([
  z.string().max(128).regex(/^(?:(?:mbx|mwh)_[a-zA-Z0-9_-]+|(?:inbox|webhook):[a-z0-9][a-z0-9-]{0,62})$/).describe('An inbox (mbx_… or inbox:<key>) or a webhook (mwh_… or webhook:<key>).'),
  z.string().max(128).regex(/^(?:con_[a-zA-Z0-9_-]+|forward:[a-z0-9][a-z0-9-]{0,62})$/).describe('A forward endpoint (con_… or forward:<name>) its recipient confirmed: it gets the whole message, as a rule\'s endpoints.<name>() call sends it.'),
]).describe('An inbox (mbx_… or inbox:<key>), a webhook (mwh_… or webhook:<key>) or a forward (con_… or forward:<name>; one still waiting for its recipient forwards mail received from the moment they allow it).');
export const RouteFields = z
  .object({
    key: RoutingKey.nullable().optional(),
    match: Address.describe(
      'Recipient, case-insensitive: an address (support@acme.com), a local-part pattern (reply+*@acme.com, *-invoices@acme.com) or a catch-all (*@acme.com, or @acme.com). The most specific route wins: exact address, then the pattern with the most literal characters, then the plus-address base, then the catch-all, then the domain default.',
    ),
    to: z
      .union([z.literal('drop'), z.array(Destination).max(10)])
      .describe(
        "Up to 10 destinations (inboxes, webhooks and forwards, a forward waiting for its recipient included), [] to keep mail stored without an inbox (readable by ID), or 'drop' to discard it. A route for an inbox's own address replaces its default delivery, so list the inbox to keep it.",
      ),
    subaddresses: z.boolean().optional().describe('Also route user+tag@host here when nothing more specific matches. Default true.'),
    enabled: z.boolean().optional().describe('A disabled route is skipped; its mail falls through to the next tier. Default true.'),
    note: z.string().max(500).optional(),
  })
  .strict();
export const MailRoute = RouteFields.extend({
  id: z.string(),
  key: RoutingKey.nullable(),
  to: RouteFields.shape.to.describe("Inbox, webhook and forward IDs, [] to keep, or 'drop'."),
  subaddresses: z.boolean(),
  enabled: z.boolean(),
  note: z.string(),
  createdAt: z.string(),
}).openapi('MailRoute');
export type Route = z.infer<typeof MailRoute>;
type RouteInput = z.infer<typeof RouteFields>;
const RoutingConfig = z.object({ version: z.number().int(), routes: z.array(MailRoute) }).openapi('RoutingConfig');
const RoutingConfigFile = z
  .object({ version: z.number().int().optional().describe('Ignored on apply; send the version in If-Match.'), routes: z.array(RouteFields).max(10000) })
  .strict()
  .openapi('RoutingConfigFile');
const RoutingDiff = z.object({ before: MailRoute.nullable(), after: MailRoute.nullable() }).openapi('RoutingDiff');
const RoutingChange = z
  .object({
    version: z.number().int().describe('Routing version after the change; unchanged for a dry run or when nothing changed.'),
    diff: z.array(RoutingDiff).describe('before null: created; after null: deleted. Shortened to fit the response size budget when large; read the full history from getRoutingAudit.'),
    diffCount: z.number().int().optional().describe('Present when diff was shortened: total changed routes in this version.'),
    diffTruncated: z.literal(true).optional().describe('Present and true when diff was shortened to fit the response size budget; read full changes from getRoutingAudit.'),
    warnings: z.array(z.string()),
  })
  .openapi('RoutingChange');
const ActorView = z.object({ type: z.string(), id: z.string() });
const RoutingVersion = z
  .object({ version: z.number().int(), createdAt: z.string(), actor: ActorView, changes: z.number().int(), note: z.string().nullable() })
  .openapi('RoutingVersion');
const RoutingAuditEntry = z
  .object({
    version: z.number().int(),
    resourceId: z.string(),
    before: MailRoute.nullable(),
    after: MailRoute.nullable(),
    actor: ActorView,
    requestId: z.string().nullable(),
    note: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('RoutingAuditEntry');
const Verdict = z.enum(['PASS', 'FAIL', 'GRAY', 'PROCESSING_FAILED']);
const RoutingTest = z
  .object({
    messageId: z.string().max(120).optional().describe('Replay a stored inbound message with its envelope recipients and SES verdicts.'),
    raw: z
      .string()
      .max(Math.ceil(PARSE_LIMIT / 3) * 4)
      .optional()
      .describe('A pasted message: base64 RFC 822 MIME, parsed with the ingest limits. Its To and Cc are the recipients unless envelope.to is set.'),
    envelope: z
      .object({ to: z.array(Address.regex(ADDRESS)).min(1).max(100) })
      .strict()
      .optional()
      .describe('Envelope recipients, including Bcc.'),
    verdicts: z
      .object({ spam: Verdict.optional(), dmarc: Verdict.optional() })
      .strict()
      .optional()
      .describe('SES verdicts for envelope and raw tests. Each defaults to PASS. A stored message uses its own.'),
    config: RoutingConfigFile.optional().describe('Unsaved routes to test instead of the saved ones: a PUT /v1/routing body. Nothing is saved.'),
    version: z.number().int().nonnegative().optional().describe('Test the routes of an earlier version instead of the saved ones.'),
  })
  .strict()
  .openapi('RoutingTest');
const RoutedRecipient = z
  .object({
    address: z.string(),
    tier: z
      .enum(ROUTE_TIERS)
      .describe(
        "What matched: exact (an exact route), address (an inbox's own address or alias), pattern (a local-part pattern), subaddress (the route or inbox of user@ for user+tag@), catchall (*@host) or default (the domain's catch-all setting).",
      ),
    route: z.string().nullable().describe('Route ID; null for an address, an address wildcard rule or the domain default.'),
    inboxes: z.array(z.string()),
    webhooks: z.array(z.string()).describe('Webhook and forward endpoint IDs.'),
    skipBase:z.literal(true).optional().describe('A base route explicitly disables plus-address fallback.'),
    limited:z.literal(true).optional().describe('Fan-out was capped. The recipient is also recorded as unrouted.'),
    dropped: z.boolean(),
    junk: z.boolean(),
    domainDefault: z.enum(['store', 'create_address']).describe('The domain catch-all setting, used when tier is default.'),
    warnings: z.array(z.string()).describe('Destinations that were skipped, and why.'),
  })
  .openapi('RoutedRecipient');
const RoutingTestResult = z
  .object({
    version: z.number().int().describe('The routing version tested; for unsaved config, the saved version it starts from.'),
    unsaved: z.boolean(),
    verdicts: z.object({ spam: z.string(), dmarc: z.string() }),
    message: z.object({ from: z.string().nullable(), subject: z.string().nullable() }).nullable(),
    recipients: z.array(RoutedRecipient),
  })
  .openapi('RoutingTestResult');

const fail = (status: number, code: string, message: string, field?: string) => new ApiError(status, code, message, field);
const columns = sql`id,key,match,destinations AS "to",subaddresses,enabled,note,created_at::text AS "createdAt"`;
const hostOf = (match: string) => match.split('@')[1]!;
export const listRoutes = async (tx: DbExecutor, w: string) =>
  (await tx.execute<Route>(sql`SELECT ${columns} FROM mail_routes WHERE workspace_id=${w} ORDER BY match`)).rows;
async function boundedRoutePage(tx: DbExecutor, w: string, limit: number, cursor?: string) {
  const { rows } = await tx.execute<Route & { candidate_count: number }>(sql`
    WITH candidate AS (
      SELECT ${columns},
        (octet_length(match) + octet_length(destinations::text) + octet_length(note) + coalesce(octet_length(key), 0) + 192) AS row_bytes
      FROM mail_routes
      WHERE workspace_id=${w} ${cursor ? sql`AND match > ${cursor}` : sql``}
      ORDER BY match LIMIT ${limit + 1}
    ), sized AS (
      SELECT *, row_number() OVER (ORDER BY match) AS rn,
        sum(row_bytes) OVER (ORDER BY match ROWS UNBOUNDED PRECEDING) AS cum_bytes
      FROM candidate
    )
    SELECT id, key, match, "to", subaddresses, enabled, note, "createdAt", (SELECT count(*)::int FROM candidate) AS candidate_count
    FROM sized WHERE rn = 1 OR cum_bytes <= ${PAGE_MAX_BYTES}
    ORDER BY rn`);
  const candidateCount = rows[0]?.candidate_count ?? 0;
  const pageRows: Route[] = rows.slice(0, limit).map(({ candidate_count: _c, ...route }) => route);
  const fitted = fitPageByBytes(pageRows, candidateCount > pageRows.length, PAGE_MAX_BYTES, 512);
  const last = fitted.items[fitted.items.length - 1];
  return { routes: fitted.items, nextCursor: fitted.hasMore && last ? last.match : null };
}
/** The route whose match is exactly this address, as the read operations return it. */
export const routeFor = async (tx: DbExecutor, w: string, match: string) =>
  (await tx.execute<Route>(sql`SELECT ${columns} FROM mail_routes WHERE workspace_id=${w} AND match=${match}`)).rows[0] ?? null;
export const currentVersion = async (tx: DbExecutor, w: string) =>
  (await tx.execute<{ v: number }>(sql`SELECT coalesce((SELECT version FROM mail_routing_state WHERE workspace_id=${w}),0) AS v`)).rows[0]!.v;
/** Read one bounded slice of immutable identities and their version's diff in the same snapshot.
 * The first change AFTER v contains the exact before-image, even after older audit deltas expire. */
async function versionPage(tx:DbExecutor,w:string,v:number,offset:number,size:number){
  if(v===0)return {routes:[] as Route[],diff:[] as z.infer<typeof RoutingDiff>[],nextCursor:null};
  const manifest=(await tx.execute<{routes:Route[];diff:z.infer<typeof RoutingDiff>[];more:boolean}>(sql`
    SELECT cardinality(route_ids)>${offset+size} OR cardinality(changed_ids)>${offset+size} AS more,
      coalesce((SELECT jsonb_agg(coalesce(change.before,to_jsonb(live)) ORDER BY ord) FROM unnest(route_ids[${offset+1}:${offset+size}]) WITH ORDINALITY ids(ref,ord)
        LEFT JOIN LATERAL (SELECT a.before FROM mail_routing_audit a WHERE a.workspace_id=${w} AND a.resource_id=ref AND a.version>${v} ORDER BY a.version LIMIT 1) change ON true
        LEFT JOIN LATERAL (SELECT ${columns} FROM mail_routes r WHERE r.workspace_id=${w} AND r.id=ref) live ON change.before IS NULL),'[]') AS routes,
      coalesce((SELECT jsonb_agg(jsonb_build_object('before',a.before,'after',a.after) ORDER BY ord) FROM unnest(changed_ids[${offset+1}:${offset+size}]) WITH ORDINALITY ids(ref,ord)
        JOIN mail_routing_audit a ON a.workspace_id=${w} AND a.version=${v} AND a.resource_id=ref),'[]') AS diff
    FROM mail_routing_versions WHERE workspace_id=${w} AND version=${v} AND created_at>=now()-interval '1 year'`)).rows[0];
  if(!manifest)throw fail(410,'VERSION_EXPIRED','This version is no longer retained (one year or 256 versions).');
  return {routes:manifest.routes,diff:manifest.diff,nextCursor:manifest.more?String(offset+size):null};
}
async function historical(tx:DbExecutor,w:string,v:number){
  const routes:Route[]=[];let next:string|null='0';do{const page=await versionPage(tx,w,v,Number(next),256);routes.push(...page.routes);next=page.nextCursor;}while(next);return routes;
}
/** Opts a workspace into the routed store without changing routing (the version stays the same). */
export const enableRouting = (tx: DbExecutor, w: string) =>
  tx.execute(sql`INSERT INTO mail_routing_state(workspace_id) VALUES(${w}) ON CONFLICT DO NOTHING`);

function findRoute(routes: Route[], ref: string) {
  const route = routes.find((r) => r.id === ref || r.key === ref);
  if (!route) throw fail(404, 'NOT_FOUND', `Route ${ref} was not found. List routes with GET /v1/routing/routes.`);
  return route;
}
export function makeRoute(fields: RouteInput, previous?: Route): Route {
  return {
    id: previous?.id ?? id('rte'),
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    key: null,
    enabled: true,
    subaddresses: true,
    note: '',
    ...fields,
    match: fields.match.replace(/^@/, '*@'),
  };
}
/** A config entry updates the route with its key, or else the keyless route with its match. */
function applyEntries(routes:Route[],entries:RouteInput[]){
  const byKey=new Map(routes.filter(r=>r.key).map(r=>[r.key,r])),byMatch=new Map(routes.map(r=>[r.match,r]));
  return entries.map(f=>{const sameMatch=byMatch.get(f.match.replace(/^@/,'*@'));return makeRoute(f,(f.key?byKey.get(f.key):undefined)??(!f.key||!sameMatch?.key?sameMatch:undefined));});
}
const referenceSet=(routes:RouteInput[])=>new Set(routes.flatMap(r=>Array.isArray(r.to)?r.to:[]));
function checkReferenceBudget(routes:RouteInput[]){if(referenceSet(routes).size>1000)throw fail(422,'DESTINATION_LIMIT','At most 1,000 distinct destinations per request.','to');}
const same = (a: Route | undefined, b: Route) =>
  !!a && (['key', 'match', 'to', 'enabled', 'subaddresses', 'note'] as const).every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));

function checkRoutes(routes: Route[]) {
  const matches = new Map<string, Route>(),
    keys = new Set<string>(),
    patterns = new Map<string, number>();
  const ids=new Set<string>();
  let exact = 0;
  for (const r of routes) {
    if(ids.has(r.id))throw fail(409,'ROUTE_CONFLICT','Two entries update the same route.');ids.add(r.id);
    if (/^[*]{2,}@/.test(r.match) || !ADDRESS.test(r.match) || hostOf(r.match).includes('*'))
      throw fail(
        422,
        'INVALID_MATCH',
        `"${r.match}" is not a valid match. Use an address (support@acme.com), a local-part pattern (reply+*@acme.com) or a catch-all (*@acme.com).`,
        'match',
      );
    const other = matches.get(r.match);
    if (other)
      throw fail(409, 'ROUTE_CONFLICT', `Route ${other.key ?? other.id} already matches ${r.match}. Add the destinations to that route instead.`, 'match');
    if (r.key && keys.has(r.key)) throw fail(409, 'ROUTE_CONFLICT', `Route key ${r.key} is used twice. Keys must be unique.`, 'key');
    matches.set(r.match, r);
    if (r.key) keys.add(r.key);
    if (!r.match.includes('*')) {
      if (++exact > 10000) throw fail(409, 'ROUTE_LIMIT', 'A workspace has at most 10,000 exact routes. Use a pattern or catch-all route.');
      continue;
    }
    const n = (patterns.get(hostOf(r.match)) ?? 0) + 1;
    if (n > 64) throw fail(409, 'ROUTE_LIMIT', `${hostOf(r.match)} has more than 64 pattern routes, the limit per host.`);
    patterns.set(hostOf(r.match), n);
  }
}
/** A route delivers to inboxes, webhooks and forwards: a Slack or Discord endpoint is never a destination, by ID or by name. */
const realWebhook = sql`h.type='webhook'`,
  forward = sql`h.type='forward'`;
/**
 * Replaces keys with IDs in place. Leniently (restores), drops destinations that no longer exist instead of failing.
 * A route may name a forward still waiting for its recipient: nothing reaches them until they allow it, and then only mail
 * received from that moment (mailbox-events.ts fanout, sendForward). A forward a route did not already name must not be
 * declined; one its recipient declined later stays, and its deliveries are refused, so a decline never blocks a save.
 */
async function resolveDestinations(tx: DbExecutor, w: string, routes: Route[], lenient: boolean, previous: Map<string, Route> = new Map()) {
  const refs = [...referenceSet(routes)],
    warnings: string[] = [];
  if (!refs.length) return warnings;
  const rows = (
    await tx.execute<{ ref: string; id: string; pending: boolean }>(
      sql`WITH refs AS MATERIALIZED (SELECT ref,split_part(ref,':',2) AS key FROM jsonb_array_elements_text(${JSON.stringify(refs)}::jsonb) ref)
        SELECT ref,b.id,false AS pending FROM refs JOIN mailboxes b ON b.workspace_id=${w} AND b.id=ref WHERE starts_with(ref,'mbx_')
        UNION ALL SELECT ref,b.id,false FROM refs JOIN mailboxes b ON b.workspace_id=${w} AND b.key=refs.key WHERE starts_with(ref,'inbox:')
        UNION ALL SELECT ref,h.id,false FROM refs JOIN mailbox_webhooks h ON h.workspace_id=${w} AND h.id=ref AND ${realWebhook} WHERE starts_with(ref,'mwh_')
        UNION ALL SELECT ref,h.id,false FROM refs JOIN mailbox_webhooks h ON h.workspace_id=${w} AND h.key=refs.key AND ${realWebhook} WHERE starts_with(ref,'webhook:')
        UNION ALL SELECT ref,h.id,h.declined_at IS NOT NULL FROM refs JOIN mailbox_webhooks h ON h.workspace_id=${w} AND h.id=ref AND ${forward} WHERE starts_with(ref,'con_')
        UNION ALL SELECT ref,h.id,h.declined_at IS NOT NULL FROM refs JOIN mailbox_webhooks h ON h.workspace_id=${w} AND h.key=refs.key AND ${forward} WHERE starts_with(ref,'forward:')`,
    )
  ).rows;
  const found = new Map(rows.map((d) => [d.ref, d.id])),
    pending = new Set(rows.filter((d) => d.pending).map((d) => d.ref));
  for (const r of routes) {
    if (!Array.isArray(r.to)) continue;
    const missing = r.to.filter((ref) => !found.has(ref));
    if (missing.length && !lenient)
      throw fail(
        422,
        'UNKNOWN_DESTINATION',
        `${missing[0]} is not an inbox, webhook or forward in this workspace. Use an ID from listInboundAddresses, listInboundWebhooks or listEndpoints, or a key such as inbox:support or forward:team.`,
        'to',
      );
    const before = previous.get(r.id)?.to,
      unconfirmed = lenient ? undefined : r.to.find((ref) => pending.has(ref) && !(Array.isArray(before) && before.includes(found.get(ref)!)));
    if (unconfirmed)
      throw fail(
        422,
        'FORWARD_NOT_CONFIRMED',
        `${unconfirmed} is a forward its recipient declined or stopped. A new request is possible 30 days after; getEndpoint shows its status.`,
        'to',
      );
    for (const ref of missing) warnings.push(`Removed ${ref} from ${r.match}: it no longer exists.`);
    r.to = [...new Set(r.to.flatMap((ref) => found.get(ref) ?? []))];
  }
  return warnings;
}

/** Validates and writes a whole route set as one version: rows, one audit row per changed route, and the affected host plans. */
export async function save(
  tx: DbExecutor,
  c: Ctx,
  w: string,
  version: number,
  before: Route[],
  after: Route[],
  { dryRun = false, lenient = false, note = '', audit }: { dryRun?: boolean; lenient?: boolean; note?: string; audit?: { action: string; details?: Record<string, unknown> } } = {},
) {
  if(after.length>10000)throw fail(422,'ROUTE_LIMIT','A workspace supports at most 10,000 routes.');
  const afterBytes = utf8Bytes(JSON.stringify(after));
  if (afterBytes > ROUTING_CONFIG_MAX_BYTES && afterBytes >= utf8Bytes(JSON.stringify(before)))
    throw fail(422, 'ROUTE_CONFIG_TOO_LARGE', 'The workspace routing config exceeds 2 MiB. Shorten route notes or consolidate routes with patterns.', 'routes');
  checkRoutes(after);
  const previous = new Map(before.map((r) => [r.id, r])),
    kept = new Set(after.map((r) => r.id));
  const warnings = await resolveDestinations(
    tx,
    w,
    after.filter((r) => !same(previous.get(r.id), r)),
    lenient,
    previous,
  );
  const diff = [
    ...before.filter((r) => !kept.has(r.id)).map((r) => ({ before: r, after: null })),
    ...after.filter((r) => !same(previous.get(r.id), r)).map((r) => ({ before: previous.get(r.id) ?? null, after: r })),
  ];
  if (!diff.length) return { version, diff, warnings };
  const routes = diff.flatMap((d) => [d.before, d.after]).filter((r): r is Route => !!r);
  const domains = new Map(
    (
      await tx.execute<{ id: string; host: string }>(
        sql`SELECT id,coalesce(receiving_host,name) AS host FROM mailbox_domains WHERE workspace_id=${w} AND coalesce(receiving_host,name) IN (SELECT jsonb_array_elements_text(${JSON.stringify([...new Set(routes.map((r) => hostOf(r.match)))])}::jsonb))`,
      )
    ).rows.map((d) => [d.host, d.id]),
  );
  for (const { after: r } of diff)
    if (r && !domains.has(hostOf(r.match)))
      throw fail(
        422,
        'UNKNOWN_HOST',
        `${hostOf(r.match)} is not a receiving domain in this workspace. Check the spelling, or enable receiving for it first.`,
        'match',
      );
  const boundedDiff = () => {
    const fitted = fitPageByBytes(diff, false, PAGE_MAX_BYTES, 512);
    const truncated = fitted.items.length < diff.length;
    return { diff: fitted.items, ...(truncated ? { diffCount: diff.length, diffTruncated: true as const } : {}) };
  };
  if (dryRun) return { version, ...boundedDiff(), warnings };
  const [{ next }] = (
    await tx.execute<{ next: number }>(
      sql`INSERT INTO mail_routing_state(workspace_id,version) VALUES(${w},1) ON CONFLICT(workspace_id) DO UPDATE SET version=mail_routing_state.version+1 RETURNING version AS next`,
    )
  ).rows as [{ next: number }];
  const CHUNK = 500;
  const changedIds = diff.map((d) => (d.before ?? d.after)!.id);
  for (let i = 0; i < changedIds.length; i += CHUNK) {
    await tx.execute(sql`DELETE FROM mail_routes WHERE workspace_id=${w} AND id = ANY(${sql.param(changedIds.slice(i, i + CHUNK))}::text[])`);
  }
  const rows = diff.flatMap((d) => (d.after ? [{ ...d.after, domain: domains.get(hostOf(d.after.match)) }] : []));
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx.execute(
      sql`INSERT INTO mail_routes(id,workspace_id,key,domain_id,match,destinations,subaddresses,enabled,note,created_at) SELECT id,${w},key,domain,match,"to",subaddresses,enabled,note,"createdAt" FROM jsonb_to_recordset(${JSON.stringify(rows.slice(i, i + CHUNK))}::jsonb) AS x(id text,key text,domain text,match text,"to" jsonb,subaddresses boolean,enabled boolean,note text,"createdAt" timestamptz)`,
    );
  }
  const who = c.get('actor');if(who.grantId&&rows.length)await (await import('./rituals.js')).ownReceiving(tx,c,'route',rows.map(r=>r.id));
  await tx.execute(sql`INSERT INTO mail_routing_versions(workspace_id,version,route_ids,changed_ids,actor_type,actor_id,note)
    VALUES(${w},${next},ARRAY(SELECT id FROM mail_routes WHERE workspace_id=${w} ORDER BY id),${sql.param([...changedIds].sort())}::text[],${who.credential??'apiKey'},${who.keyId},${note||null})`);
  // At most one retired manifest on a normal write; its audit rows share the same transaction.
  await tx.execute(sql`DELETE FROM mail_routing_versions WHERE workspace_id=${w} AND version<=${next-256}`);
  // One account audit row per committed version, alongside chunked per-route history writes so large applies never stringify one 28 MB payload.
  const brief = (r: Route | null) => r && { match: r.match, key: r.key ?? null, enabled: r.enabled, destinations: Array.isArray(r.to) ? r.to.length : r.to };
  const single = audit?.action.startsWith('route.') ? diff[0]! : null;
  for (let i = 0; i < diff.length; i += CHUNK) {
    await tx.execute(
      sql`INSERT INTO mail_routing_audit(workspace_id,version,resource_id,before,after,actor_type,actor_id,request_id,note)
        SELECT ${w},${next},coalesce(before->>'id',after->>'id'),before,after,${who.credential ?? 'apiKey'},${who.keyId},${c.get('requestId')},${note || null}
        FROM jsonb_to_recordset(${JSON.stringify(diff.slice(i, i + CHUNK))}::jsonb) x(before jsonb,after jsonb)`,
    );
  }
  if (audit) {
    await tx.execute(auditInsert(auditContext(c), { action: audit.action, workspaceId: w, target: single ? { type: 'route', id: (single.before ?? single.after)!.id } : { type: 'routing', id: w },
      ...(single ? { before: brief(single.before) ?? undefined, after: brief(single.after) ?? undefined } : {}),
      details: { version: next, changes: diff.length, created: diff.filter(d => !d.before).length, deleted: diff.filter(d => !d.after).length, routes: after.length, ...audit.details } }));
  }
  // Exact routes are point lookups; only pattern and catch-all changes rewrite their host's plan.
  for (const domain of new Set(routes.filter((r) => r.match.includes('*')).map((r) => domains.get(hostOf(r.match)))))
    if (domain) await tx.execute(sql`SELECT mail_compile_routes(${w},${domain})`);
  return { version: next, ...boundedDiff(), warnings };
}
/** A route or address-flow write's If-Match against the version it read: a stale one is refused and nothing changes. */
export function checkVersion(c: Ctx, version: number) {
  const expected = c.req.header('if-match')?.replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
  if (expected !== undefined && expected !== '*' && expected !== String(version))
    throw fail(
      409,
      'VERSION_CONFLICT',
      `Routing is at version ${version}, not ${expected}. Read GET /v1/routing again, reapply your change and send If-Match: "${version}".`,
    );
}
/** Removes a deleted inbox or webhook from every route, as one routing version, or refuses without ?detach=true. */
export async function detachDestination(tx: DbExecutor, c: Ctx, w: string, destination: string) {
  await lockMailboxLane(tx, w, 'address');
  const using = (
    await tx.execute<{ match: string }>(sql`SELECT match FROM mail_routes WHERE workspace_id=${w} AND destinations ? ${destination} ORDER BY match LIMIT 3`)
  ).rows.map((r) => r.match);
  if (!using.length) return;
  if (c.req.query('detach') !== 'true')
    throw fail(
      409,
      'REFERENCED',
      `Routes for ${using.join(', ')}${using.length === 3 ? ' and more' : ''} deliver to ${destination}. Delete with ?detach=true to remove it from those routes too, or change the routes first.`,
    );
  if (c.get('actor').grantId)throw denied('ADMIN_REQUIRED','Delegated credentials cannot detach route destinations.',{ permission: 'receivingRules', level: 'write', credential: 'notDelegated' });
  const routes = await listRoutes(tx, w);
  await save(
    tx,
    c,
    w,
    await currentVersion(tx, w),
    routes,
    routes.map((r) => (Array.isArray(r.to) && r.to.includes(destination) ? { ...r, to: r.to.filter((id) => id !== destination) } : r)),
    { note: `Detach ${destination}` },
  );
}
class RolledBack<T> extends Error {
  constructor(readonly value: T) {
    super('Rolled back');
  }
}
/** Runs work in a transaction and always rolls it back: dry runs exercise the real write path without keeping it. */
export async function rolledBack<T>(db: Runtime['db'], work: (tx: DbExecutor) => Promise<T>): Promise<T> {
  try {
    await db.transaction(async (tx) => {
      throw new RolledBack(await work(tx));
    });
  } catch (error) {
    if (error instanceof RolledBack) return error.value as T;
    throw error;
  }
  throw new Error('Rolled-back transaction committed.');
}
type MimeAddress = { address?: string; group?: MimeAddress[] };
const addressesOf = (list: MimeAddress[] | undefined): string[] =>
  (list ?? []).flatMap((a) => (a.group ? addressesOf(a.group) : a.address ? [a.address.trim().toLowerCase()] : []));

export function registerRouting(app: App) {
  const path = '/v1/routing',
    meta = { security, tags: ['Routing'] };
  // Reads and the dry run need read with receiving consent; every change goes through edit.
  const workspace = (c: Ctx) => receivingAdmin(c).workspaceId;
  const edit = async (
    c: Ctx,
    change: (routes: Route[], tx: DbExecutor, version: number) => Route[] | Promise<Route[]>,
    options: Parameters<typeof save>[6] = {},
  ) => {
    const w = receivingAdmin(c, 'change routes').workspaceId;
    const result = await c.env.db.transaction(async (tx) => {
      await lockMailboxLane(tx, w, 'address');
      // Hold the approval before any route row: a removal disables an approval's routes after it has taken the approval.
      if (c.get('actor').grantId) await (await import('./rituals.js')).holdReceiving(tx, c);
      const version = await currentVersion(tx, w);
      checkVersion(c, version);
      const routes = await listRoutes(tx, w);
      return save(tx, c, w, version, routes, await change(routes, tx, version), options);
    });
    c.header('ETag', `"${result.version}"`);
    return result;
  };
  const IfMatch = z.string().max(32).describe('Apply only if routing is still at this version, from GET /v1/routing or a previous ETag.'),
    ifMatch = z.object({ 'if-match': IfMatch.optional() });
  const RouteParam = z.object({ id: z.string().max(128).describe('Route ID or key.') }),
    VersionParam = z.object({ v: z.coerce.number().int().nonnegative() }),
    Page = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path,
      operationId: 'getRouting',
      summary: 'Read the routing config',
      description:
        "Every explicit route and the current version (also the ETag). With format=config, routes omit IDs and refer to keyed inboxes, webhooks and forwards as inbox:<key>, webhook:<key> and forward:<name>, ready to edit and PUT back. Always returns the complete config (writes are bounded to 2 MiB total so a round-trip apply never drops routes). An inbox's own addresses route to it without a route. " + readLimitNote(5),
      request: { query: z.object({ format: z.enum(['config']).optional() }) },
      responses: { 200: response(z.union([RoutingConfig, RoutingConfigFile])), ...errors },
    }),
    async (c) => {
      const w = workspace(c), q = c.req.valid('query');
      return await withBoundedRead(c, async () => {
        const { version, routes, keys } = await budgetedRead(c.env.db, async (db) => {
          const config = (
            await db.execute<{ version: number; routes: Route[] }>(
              sql`SELECT coalesce((SELECT version FROM mail_routing_state WHERE workspace_id=${w}),0) AS version,coalesce((SELECT jsonb_agg(r ORDER BY match) FROM (SELECT ${columns} FROM mail_routes WHERE workspace_id=${w}) r),'[]') AS routes`,
            )
          ).rows[0]!;
          if (q.format !== 'config') return { ...config, keys: null as Map<string, string> | null };
          const destIds = [...new Set(config.routes.flatMap((r) => (Array.isArray(r.to) ? r.to : [])))];
          const keyRows = destIds.length
            ? (await db.execute<{ id: string; ref: string }>(
                sql`SELECT id,'inbox:'||key AS ref FROM mailboxes WHERE workspace_id=${w} AND key IS NOT NULL AND id = ANY(${sql.param(destIds)}::text[])
                  UNION ALL SELECT id,'webhook:'||key FROM mailbox_webhooks h WHERE workspace_id=${w} AND key IS NOT NULL AND ${realWebhook} AND id = ANY(${sql.param(destIds)}::text[])
                  UNION ALL SELECT id,'forward:'||key FROM mailbox_webhooks h WHERE workspace_id=${w} AND key IS NOT NULL AND ${forward} AND id = ANY(${sql.param(destIds)}::text[])`,
              )).rows
            : [];
          return { ...config, keys: new Map(keyRows.map((r) => [r.id, r.ref])) };
        }, readLimit(5));
        c.header('ETag', `"${version}"`);
        if (q.format !== 'config') return c.json({ version, routes }, 200);
        const mapped = routes.map(({ id: _id, createdAt: _at, ...r }) => ({ ...r, to: Array.isArray(r.to) ? r.to.map((d) => keys!.get(d) ?? d) : r.to }));
        return c.json({ version, routes: mapped }, 200);
      }, { route: 'routing.get', workspaceId: w }) as never;
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'put',
      path,
      operationId: 'applyRouting',
      summary: 'Replace every route',
      description:
        'Declarative apply: routes are matched by key (or, without a key, by match), so applying the same file again changes nothing. Routes missing from the file are deleted. Requires If-Match with the version you read. Total stored routes are bounded to 2 MiB (422 ROUTE_CONFIG_TOO_LARGE). dryRun=true returns the diff without saving.',
      request: {
        headers: z.object({ 'if-match': IfMatch }),
        query: z.object({ dryRun: z.enum(['true', 'false']).optional() }),
        body: json(RoutingConfigFile),
      },
      responses: { 200: response(RoutingChange), ...errors },
    }),
    async (c) => {
      checkReferenceBudget(c.req.valid('json').routes);
      const w = receivingAdmin(c, 'change routes').workspaceId;
      return await withBoundedRead(c, async () => c.json(
        await edit(c, (routes) => applyEntries(routes, c.req.valid('json').routes), {
          dryRun: c.req.valid('query').dryRun === 'true', audit: { action: 'routing.apply' },
        }),
        200,
      ), { route: 'routing.apply', workspaceId: w }) as never;
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: path + '/routes',
      operationId: 'listRoutes',
      summary: 'List routes',
      description: 'Explicit routes ordered by match. Pages are bounded by row count (up to 100) and response size; pass nextCursor as cursor to continue. ' + readLimitNote(5),
      request: { query: z.object({ cursor: z.string().max(254).optional(), limit: z.coerce.number().int().min(1).max(100).default(100) }) },
      responses: { 200: response(z.object({ data: z.array(MailRoute), nextCursor: z.string().nullable() })), ...errors },
    }),
    async (c) => {
      const w = workspace(c), q = c.req.valid('query');
      return await withBoundedRead(c, async () => {
        const page = await budgetedRead(c.env.db, db => boundedRoutePage(db, w, q.limit, q.cursor), readLimit(5));
        return c.json({ data: page.routes, nextCursor: page.nextCursor }, 200);
      }, { route: 'routing.listRoutes', workspaceId: w }) as never;
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'post',
      path: path + '/routes',
      operationId: 'createRoute',
      summary: 'Route a recipient',
      description:
        'Example: { "match": "support@acme.com", "to": ["inbox:support", "webhook:helpdesk", "forward:team"] } keeps the Support inbox, adds a webhook and forwards each message whole to a forward endpoint once its recipient allows it. Mail is routed by the new version as soon as this returns. Test first with testRouting.',
      request: { headers: ifMatch, body: json(RouteFields.openapi('CreateMailRoute')) },
      responses: { 201: response(MailRoute), ...errors },
    }),
    async (c) => {
      const route = makeRoute(c.req.valid('json'));
      await edit(c, (routes) => [...routes, route], { audit: { action: 'route.create' } });
      return c.json(route, 201);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: path + '/routes/{id}',
      operationId: 'getRoute',
      summary: 'Read a route',
      request: { params: RouteParam },
      responses: { 200: response(MailRoute), ...errors },
    }),
    async (c) => {
      const w = workspace(c), ref = c.req.valid('param').id;
      const route = (await c.env.db.execute<Route>(sql`SELECT ${columns} FROM mail_routes WHERE workspace_id=${w} AND (id=${ref} OR key=${ref}) LIMIT 1`)).rows[0];
      if (!route) throw fail(404, 'NOT_FOUND', `Route ${ref} was not found. List routes with GET /v1/routing/routes.`);
      return c.json(route, 200);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'patch',
      path: path + '/routes/{id}',
      operationId: 'updateRoute',
      summary: 'Change a route',
      description: 'Only supplied fields change; to replaces the whole destination list.',
      request: { params: RouteParam, headers: ifMatch, body: json(RouteFields.partial().openapi('UpdateMailRoute')) },
      responses: { 200: response(MailRoute), ...errors },
    }),
    async (c) => {
      let updated: Route | undefined;
      await edit(c, (routes) => {
        const previous = findRoute(routes, c.req.valid('param').id);
        updated = makeRoute({ ...previous, ...c.req.valid('json') }, previous);
        return routes.map((r) => (r === previous ? updated! : r));
      }, { audit: { action: 'route.update', details: { fields: Object.keys(c.req.valid('json')) } } });
      return c.json(updated!, 200);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'delete',
      path: path + '/routes/{id}',
      operationId: 'deleteRoute',
      summary: 'Delete a route',
      description: "The recipient falls back to the next tier, such as its inbox's own address or the catch-all.",
      request: { params: RouteParam, headers: ifMatch },
      responses: { 200: response(RoutingChange), ...errors },
    }),
    async (c) =>
      c.json(
        await edit(c, (routes) => {
          const removed = findRoute(routes, c.req.valid('param').id);
          return routes.filter((r) => r !== removed);
        }, { audit: { action: 'route.delete' } }),
        200,
      ),
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: path + '/audit',
      operationId: 'getRoutingAudit',
      summary: 'List route changes',
      description: 'One entry per changed route, newest first, with the state before and after, who changed it and the request ID.',
      request: {
        query: Page.extend({
          resource: z.string().max(128).optional().describe('Only changes to this route ID.'),
          actor: z.string().max(200).optional().describe('Only changes by this API key, agent, MCP grant or user ID.'),
          since: z.iso.datetime().optional(),
        }),
      },
      responses: { 200: response(z.object({ data: z.array(RoutingAuditEntry), nextCursor: z.string().nullable() })), ...errors },
    }),
    async (c) => {
      const w = workspace(c),
        q = c.req.valid('query'),
        [cv, cr] = (q.cursor ?? '').split(':');
      if(q.cursor && !/^[0-9]{1,9}:[A-Za-z0-9_-]+$/.test(q.cursor))throw fail(422,'INVALID_CURSOR','Use the nextCursor from the previous page.');
      const rows = (
        await c.env.db.execute<z.infer<typeof RoutingAuditEntry>>(
          sql`SELECT version,resource_id AS "resourceId",before,after,jsonb_build_object('type',actor_type,'id',actor_id) AS actor,request_id AS "requestId",note,created_at::text AS "createdAt" FROM mail_routing_audit WHERE workspace_id=${w}
            ${q.resource ? sql`AND resource_id=${q.resource}` : sql``} ${q.actor ? sql`AND actor_id=${q.actor}` : sql``} ${q.since ? sql`AND created_at>=${q.since}::timestamptz` : sql``}
            ${q.cursor ? sql`AND (version<${Number(cv)} OR (version=${Number(cv)} AND resource_id>${cr ?? ''}))` : sql``} ORDER BY version DESC,resource_id LIMIT ${q.limit + 1}`,
        )
      ).rows;
      const last = rows.length > q.limit ? rows[q.limit - 1]! : null;
      return c.json({ data: rows.slice(0, q.limit), nextCursor: last && `${last.version}:${last.resourceId}` }, 200);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: path + '/versions',
      operationId: 'listRoutingVersions',
      summary: 'List routing versions',
      description: 'Newest first. Every change, apply, detach and restore is one version.',
      request: { query: Page },
      responses: { 200: response(z.object({ data: z.array(RoutingVersion), nextCursor: z.string().nullable() })), ...errors },
    }),
    async (c) => {
      const w = workspace(c),
        q = c.req.valid('query');
      // The cursor is a version number; anything else (1.5, 1e10) reached an integer comparison as a 500.
      if (q.cursor !== undefined && !/^\d{1,9}$/.test(q.cursor)) throw fail(422, 'INVALID_CURSOR', 'Use the nextCursor a previous page returned.', 'cursor');
      const rows = (
        await c.env.db.execute<z.infer<typeof RoutingVersion>>(
          sql`SELECT version,created_at::text AS "createdAt",jsonb_build_object('type',actor_type,'id',actor_id) AS actor,cardinality(changed_ids) AS changes,note FROM mail_routing_versions
            WHERE workspace_id=${w} AND created_at>=now()-interval '1 year' ${q.cursor ? sql`AND version<${Number(q.cursor)}` : sql``} ORDER BY version DESC LIMIT ${q.limit + 1}`,
        )
      ).rows;
      return c.json({ data: rows.slice(0, q.limit), nextCursor: rows.length > q.limit ? String(rows[q.limit - 1]!.version) : null }, 200);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: path + '/versions/{v}',
      operationId: 'getRoutingVersion',
      summary: 'Read a routing version',
      description: 'One page of routes as they were at v and that version’s changes. Pass nextCursor for the next page. History retains the latest 256 versions for up to one year.',
      request: { params: VersionParam,query:Page.extend({cursor:z.string().regex(/^\d{1,5}$/).optional()}) },
      responses: { 200: response(RoutingConfig.extend({ diff: z.array(RoutingDiff), nextCursor: z.string().nullable() }).openapi('RoutingVersionDetail')), ...errors },
    }),
    async (c) => {
      const w = workspace(c),
        v = c.req.valid('param').v;
      if (v > (await currentVersion(c.env.db, w))) throw fail(404, 'NOT_FOUND', `Version ${v} does not exist yet. List versions with GET /v1/routing/versions.`);
      const q=c.req.valid('query');return c.json({version:v,...await versionPage(c.env.db,w,v,Number(q.cursor??0),q.limit)},200);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'post',
      path: path + '/versions/{v}/restore',
      operationId: 'restoreRoutingVersion',
      summary: 'Restore a routing version',
      description:
        'Saves the routes of version v as a new version. Destinations deleted since are left out and listed in warnings. Webhook settings and domain catch-all settings are not versioned, so they keep their current values.',
      request: { params: VersionParam, headers: ifMatch },
      responses: { 200: response(RoutingChange), ...errors },
    }),
    async (c) => {
      // A restore is a change: refused as one, before the version is read.
      const v = c.req.valid('param').v,
        w = receivingAdmin(c, 'change routes').workspaceId;
      return c.json(
        await edit(
          c,
          (_routes, tx, version) => {
            if (v > version) throw fail(404, 'NOT_FOUND', `Version ${v} does not exist yet. List versions with GET /v1/routing/versions.`);
            return historical(tx, w, v);
          },
          { lenient: true, note: `Restore of v${v}`, audit: { action: 'routing.restore', details: { restoredVersion: v } } },
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'post',
      path: path + '/test',
      operationId: 'testRouting',
      summary: 'Preview where mail would go',
      description:
        'Read-only: nothing is delivered or saved. Resolves recipients with the same matcher ingest uses and explains each one. Supply envelope.to, a pasted raw message or a stored messageId; add config to test unsaved routes or version to test an earlier one. A stored message tested against the current version matches the routing recorded when it arrived, unless destinations changed since.',
      request: { body: json(RoutingTest) },
      responses: { 200: response(RoutingTestResult), ...errors },
    }),
    async (c) => {
      const w = workspace(c),
        input = c.req.valid('json');
      if(input.config){if(input.config.routes.length>1000)throw fail(422,'TEST_CONFIG_LIMIT','A preview accepts up to 1,000 routes.');checkReferenceBudget(input.config.routes);}
      if (input.messageId && input.raw) throw fail(422, 'INVALID_TEST', 'Supply messageId or raw, not both.', 'raw');
      if (input.config && input.version !== undefined) throw fail(422, 'INVALID_TEST', 'Supply config or version, not both.', 'version');
      let to = input.envelope?.to,
        spam: string = input.verdicts?.spam ?? 'PASS',
        dmarc: string = input.verdicts?.dmarc ?? 'PASS',
        received = new Date().toISOString(),
        message: { from: string | null; subject: string | null } | null = null;
      if (input.messageId) {
        actor(c,'manage');
        const row = (
          await c.env.db.execute<{ to: string[]; spam: string | null; dmarc: string | null; at: string; from: string | null; subject: string }>(
            sql`SELECT envelope_to AS "to",verdicts->>'spam' AS spam,verdicts->>'dmarc' AS dmarc,received_at::text AS at,from_address AS "from",subject FROM mail_messages WHERE workspace_id=${w} AND id=${input.messageId} AND direction='inbound' AND ${retainedMail()}`,
          )
        ).rows[0];
        if (!row) throw fail(404, 'NOT_FOUND', `Inbound message ${input.messageId} was not found.`, 'messageId');
        ({ to, at: received } = row);
        spam = row.spam ?? 'MISSING';
        dmarc = row.dmarc ?? '';
        message = { from: row.from, subject: row.subject };
      }
      if (input.raw) {
        const { parseInboundMime } = await import('./mailbox-ingest.js');
        const email = await parseInboundMime(Uint8Array.from(Buffer.from(input.raw, 'base64')));
        if (!email)
          throw fail(422, 'INVALID_MIME', 'raw is not a parseable message within the ingest limits. Send the whole message, headers included, base64-encoded.', 'raw');
        to ??= [...new Set(addressesOf([...(email.to ?? []), ...(email.cc ?? [])]).filter((a) => ADDRESS.test(a)))].slice(0, 100);
        message = { from: email.from?.address?.toLowerCase() ?? null, subject: email.subject ?? null };
      }
      if (!to?.length) throw fail(422, 'MISSING_RECIPIENTS', 'Supply envelope.to, a raw message with To or Cc addresses, or a messageId.', 'envelope');
      const read = async (tx: DbExecutor) =>
        (await tx.execute<{ p: RoutingInput }>(sql`SELECT mail_route_input(${w},${JSON.stringify(to)}::jsonb,true,${receivingPolicy(c.env.config)}::jsonb) AS p`)).rows[0]!.p;
      let routing: RoutingInput,
        version: number;
      if (input.config || input.version !== undefined) {
        // Apply the candidate routes with the real write path, read the claim input, and roll it all back.
        ({ routing, version } = await rolledBack(c.env.db, async (tx) => {
          await lockMailboxLane(tx, w, 'address');
          const saved = await currentVersion(tx, w),
            routes = await listRoutes(tx, w);
          if (input.version !== undefined && input.version > saved)
            throw fail(404, 'NOT_FOUND', `Version ${input.version} does not exist yet. List versions with GET /v1/routing/versions.`, 'version');
          const candidate = input.config
            ? applyEntries(routes,input.config.routes)
            : await historical(tx, w, input.version!);
          await save(tx, c, w, saved, routes, candidate, { lenient: !input.config });
          return { routing: await read(tx), version: input.version ?? saved };
        }));
      } else {
        routing = await read(c.env.db);
        version = routing.version;
      }
      const result = matchRouting(routing, to, spam !== 'PASS', dmarc, received);
      return c.json({ version, unsaved: !!input.config, verdicts: { spam, dmarc }, message, recipients: result.recipients }, 200);
    },
  );
}
