// PATCH /v1/inbound/addresses/{addressId}/flow: where one address's mail goes (its own route and its two-way rule),
// changed in one transaction under the address lane and one routing version. Routes and rules share that version, so
// one If-Match covers both, and a request either saves all of it or none of it. createInboundAddress's flow applies
// the same change to the address it creates, in the transaction that creates it.
import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { ApiError, errors, json, receivingAdmin, response, security, type App, type Ctx, type DbExecutor } from './core.js';
import { recordAudit } from './audit.js';
import { lockMailboxLane } from './mailbox-store.js';
import { InboundAddressId } from './inbound-threads.js';
import { RitualConfig, type Config } from './ritual-pipeline.js';
import { ritualRecipes, type RecipeParams } from './ritual-schema.js';
import { checkVersion, currentVersion, listRoutes, makeRoute, MailRoute, routeFor, RouteFields, save as saveRoutes, type Route } from './routing.js';
import { apply as applyRecipe, current as currentRules, freeKey, holdReceiving, RecipeInputParams, save as saveRules, targetRows } from './rituals.js';
import { canAsk, createEndpointRecord, Endpoint, endpointRowOf, endpointView } from './endpoints.js';
import { legacyWebhookFormat } from './brand.js';
import { rolledBack } from './idempotency.js';

/** The two-way rules the dashboard's address builder draws (ritual-schema.ts splitRecipes). */
const SPLITS = ['split', 'split-by-meaning'] as const;
const Deliver = RouteFields.shape.to.nullable()
  .describe("Where the address's mail goes: the destinations of the route for its own address, as createRoute takes them (inbox, webhook and forward IDs or keys, [] to keep it without an inbox, or 'drop'). Creates the route when there is none; null deletes it.");
const Split = z.object({
  recipe: z.enum(SPLITS).describe('split, or split-by-meaning to let the AI decide.'),
  params: RecipeInputParams.describe('The fields createRuleFromRecipe takes for this recipe: split { test, value, then, otherwise }, split-by-meaning { meaning, then, otherwise }.'),
}).strict().openapi('InboundAddressSplit');
const RuleKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
/** Slack, Discord and webhook endpoints made in the same transaction, as createEndpoint makes them: split params name
 *  them, and deliver names a webhook as webhook:<name>. A forward is made with createEndpoint first: its recipient confirms. */
const NewEndpoints = z.array(z.object({
  type: z.enum(['webhook', 'slack', 'discord']),
  name: RuleKey.describe('Endpoint name, unique in the workspace across every type.'),
  url: z.string().max(2048).describe('As createEndpoint takes it: a Slack or Discord webhook URL, or a public HTTPS URL for a webhook (its signing secret is not returned here).'),
}).strict()).max(4).describe('New endpoints this change uses, made with it: a refusal or failure makes none of them.');
/** A forward made with a new address, asked from it: createEndpoint's forward, with the address made first. */
const NewForward = z.object({
  name: RuleKey.describe('Endpoint name, unique in the workspace across every type.'),
  address: z.email().max(254).toLowerCase().describe('Recipient. They confirm with an emailed link, sent from the new address when it can send it (else as createEndpoint picks one), unless preverify applies.'),
  preverify: z.union([z.boolean(), z.literal('auto')]).default(false).describe('As createEndpoint takes it: auto skips the confirmation only for an address on a domain this workspace has verified.'),
}).strict();
/** createInboundAddress's flow: the same change for the address it creates. */
export const CreateFlow = z.object({
  endpoints: NewEndpoints.optional(),
  forward: NewForward.optional().describe('A new forward, made after the address: its recipient is asked by the new address. deliver and split may name it at once (forward:<name>; <name> in split params): mail received from the moment they allow it is forwarded, never mail received before. The answer’s forward says whether they were emailed.'),
  deliver: Deliver.optional(),
  split: Split.optional().describe('Adds a two-way rule on the new address. Its params may name the new address as inbox:<key>.'),
}).strict().openapi('CreateInboundAddressFlow');
const SetFlow = z.object({
  endpoints: NewEndpoints.optional(),
  forward: NewForward.optional().describe('A new forward: its recipient is asked by this address when it can send the request (else as createEndpoint picks one). deliver and split may name it at once: mail received from the moment they allow it is forwarded, never mail received before. The answer’s forward says whether they were emailed.'),
  deliver: Deliver.optional(),
  rule: RuleKey.optional().describe('The key of the two-way rule (split or split-by-meaning) on this address that split changes.'),
  split: Split.nullable().optional().describe('With rule: rewrites that rule. A rule other addresses also run is left as it is for them, and this address gets its own copy under a new key. Without rule: adds a new two-way rule on this address. null, with rule: takes the rule off this address, and deletes it once no address runs it.'),
}).strict().superRefine((v, ctx) => {
  if (v.rule !== undefined && v.split === undefined) ctx.addIssue({ code: 'custom', path: ['split'], message: 'Send split with rule: the rule’s new fields, or null to take it off this address.' });
  if (v.split === null && v.rule === undefined) ctx.addIssue({ code: 'custom', path: ['rule'], message: 'Name the rule split: null takes off this address.' });
}).openapi('SetInboundAddressFlow');
const FlowResult = z.object({
  version: z.number().int().describe('The routing and rules version after the change, also the ETag; unchanged when nothing changed.'),
  forward: Endpoint.extend({ confirmation: z.enum(['emailed', 'skipped']).describe('emailed: its recipient was asked to confirm (requestFrom names who asked); skipped: preverified, ready at once.') })
    .optional().describe('The forward flow.forward made, as getEndpoint returns it.'),
  route: z.union([MailRoute, z.null()]).describe("The route for the address's own address, as getRoute returns it; null when there is none."),
  rule: z.string().nullable().describe('The two-way rule this change left on the address: the rule it named, its own copy when the rule was shared, or the new rule. null when it was taken off, or no rule was named or added.'),
}).openapi('InboundAddressFlow');

type Flow = { endpoints?: z.infer<typeof NewEndpoints>; forward?: z.infer<typeof NewForward>; deliver?: z.infer<typeof Deliver>; rule?: string; split?: { recipe: string; params: RecipeParams } | null };
type Address = { id: string; address: string };
// Stored configs come back from jsonb with their keys reordered, so compare them key-order-free.
const canonical = (value: unknown) => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Whether a rule asks the AI: a recipe that decides by meaning, or a script that reads decisions(…) (omens(…) before the rename). */
const asksAi = (rule: Config['rituals'][number]) => rule.recipe ? !!ritualRecipes.find(r => r.id === rule.recipe!.id)?.decisions : /\b(?:decisions|omens)\s*\(/.test(rule.source);
/** The AI reads a domain's mail (evaluateDomains) while a rule there asks it: a change that took the last such rule off
 *  the domain takes the domain off too. A rule attached anywhere on it keeps it, on or off. */
async function forgetDomain(tx: DbExecutor, w: string, config: Config, host: string): Promise<Config> {
  if (!config.evaluateDomains.includes(host)) return config;
  const asking = new Set(config.rituals.filter(asksAi).map(r => r.key));
  const targets = [...new Set(config.attachments.filter(a => asking.has(a.ritual)).map(a => a.target))];
  const hosts = new Set((targets.length ? await targetRows(tx, w, targets) : []).map(r => r.address.split('@')[1]!.toLowerCase()));
  return hosts.has(host) ? config : { ...config, evaluateDomains: config.evaluateDomains.filter(d => d !== host) };
}
/** The rule config after the split change, every refusal included, before anything is written. */
async function nextRules(tx: DbExecutor, c: Ctx, w: string, config: Config, box: Address, flow: Flow): Promise<{ config: Config; rule: string | null; action: string }> {
  const split = flow.split, base = `${split?.recipe}-${box.address.split('@')[0]}`;
  const mine = (target: string) => target === box.id || target === box.address;
  // Named after the recipe and the address, as createRuleFromRecipe names one: split-support, split-support-2.
  if (!flow.rule) {
    if (!split) return { config, rule: null, action: '' };
    const key = freeKey(config, base);
    return { config: await applyRecipe(config, tx, c, w, key, split.recipe, split.params, [box.id], undefined), rule: key, action: 'ritual.recipe' };
  }
  const key = flow.rule, prev = config.rituals.find(r => r.key === key);
  if (!prev) throw new ApiError(404, 'NOT_FOUND', `Rule ${key} was not found.`, 'rule');
  if (!prev.recipe || !(SPLITS as readonly string[]).includes(prev.recipe.id)) throw new ApiError(422, 'NOT_A_SPLIT', `${key} is not a two-way rule (split or split-by-meaning). Change it with updateRuleFromRecipe or saveRule.`, 'rule');
  const here = config.attachments.filter(a => a.ritual === key && mine(a.target));
  if (!here.length) throw new ApiError(422, 'RULE_NOT_ON_ADDRESS', `${key} does not run on ${box.address}. getInboundOverview lists the rules on each address.`, 'rule');
  const shared = config.attachments.some(a => a.ritual === key && !mine(a.target));
  // Taking an AI split off this address, or rewriting it to one that doesn't ask, may leave its domain with no rule that asks the AI.
  const host = box.address.split('@')[1]!.toLowerCase(), forget = (next: Config) => asksAi(prev) ? forgetDomain(tx, w, next, host) : next;
  if (!split) {
    const attachments = config.attachments.filter(a => !(a.ritual === key && mine(a.target)));
    return { config: await forget({ ...config, attachments, rituals: shared ? config.rituals : config.rituals.filter(r => r.key !== key) }), rule: null, action: shared ? 'ritual.attach' : 'ritual.delete' };
  }
  const rewritten = await applyRecipe(config, tx, c, w, key, split.recipe, split.params, undefined, undefined);
  if (same(rewritten.rituals.find(r => r.key === key), prev)) return { config, rule: key, action: '' };
  if (!shared) return { config: await forget(rewritten), rule: key, action: 'ritual.recipe' };
  // Shared: the other addresses keep the rule as it is; this address's attachments run its own copy, in their places.
  const copy = freeKey(config, base);
  const moved = { ...config, attachments: config.attachments.map(a => a.ritual === key && mine(a.target) ? { ...a, ritual: copy } : a) };
  return { config: await forget(await applyRecipe(moved, tx, c, w, copy, split.recipe, split.params, here.map(a => a.target), prev.enabled)), rule: copy, action: 'ritual.recipe' };
}

/**
 * Applies one address's flow in the caller's transaction, which holds the address lane and read `version`: its route
 * through routing's write, then its rules through the rule write, both in the one version the route write took (or the
 * next one when only the rules change). A refusal from either throws, so the caller's transaction keeps nothing.
 */
export async function applyFlow(tx: DbExecutor, c: Ctx, w: string, box: Address, flow: Flow, version: number) {
  await holdReceiving(tx, c);
  // New endpoints first: the rule names them, and the route takes a new webhook by its ID.
  const made = new Map<string, string>();
  for (const e of flow.endpoints ?? []) {
    const spec = e.type === 'webhook'
      ? { type: 'webhook' as const, key: e.name, name: e.name, url: e.url, description: '', eventTypes: [], addressIds: null, paused: false, format: legacyWebhookFormat }
      : { type: e.type, key: e.name, url: e.url };
    const { row } = await createEndpointRecord(tx, c, w, spec as Parameters<typeof createEndpointRecord>[3], 'endpoints');
    await recordAudit(tx, c, { action: 'endpoint.create', workspaceId: w, target: { type: 'endpoint', id: row.id }, after: { name: e.name, type: e.type } });
    if (e.type === 'webhook') made.set('webhook:' + e.name, row.id);
  }
  // A new address's forward, asked by the address itself when it can send the request (a built-in domain may not).
  let forward: Awaited<ReturnType<typeof createEndpointRecord>>['row'] | undefined;
  if (flow.forward) {
    const f = flow.forward, from = await canAsk(c.env, tx, w, box.address, f.address) ? box.id : undefined;
    ({ row: forward } = await createEndpointRecord(tx, c, w, { type: 'forward', key: f.name, address: f.address, from, preverify: f.preverify }, 'forward.name'));
    await recordAudit(tx, c, { action: 'endpoint.create', workspaceId: w, target: { type: 'endpoint', id: forward.id }, after: { name: f.name, type: 'forward', address: f.address, preverified: forward.verified } });
  }
  if (Array.isArray(flow.deliver)) flow = { ...flow, deliver: flow.deliver.map(ref => made.get(ref) ?? ref) };
  const before = await currentRules(tx, w), rules = await nextRules(tx, c, w, before.config, box, flow);
  let saved = version;
  if (flow.deliver !== undefined) {
    const routes = await listRoutes(tx, w), prev = routes.find(r => r.match === box.address), deliver = flow.deliver;
    // Only the destinations change: id, key, note, subaddresses and enabled stay, so a paused route stays paused.
    const after: Route[] = deliver === null ? routes.filter(r => r !== prev)
      : prev ? routes.map(r => r === prev ? { ...prev, to: deliver } : r) : [...routes, makeRoute({ match: box.address, to: deliver })];
    if (prev || deliver !== null) {
      try {
        ({ version: saved } = await saveRoutes(tx, c, w, version, routes, after, { audit: deliver === null ? { action: 'route.delete' } : prev ? { action: 'route.update', details: { fields: ['to'] } } : { action: 'route.create' } }));
      } catch (e) { if (e instanceof ApiError && e.field === 'to') e.field = 'deliver'; throw e; }
    }
  }
  if (rules.action && !same(rules.config, before.config)) {
    const result = await saveRules(tx, c, w, RitualConfig.parse(rules.config), saved, false, saved !== version);
    const key = rules.rule ?? flow.rule!;
    await recordAudit(tx, c, { action: rules.action, workspaceId: w, target: { type: 'ritual', id: key }, before: { version }, after: { version: result.version, key, ...(flow.split ? { recipe: flow.split.recipe } : {}) } });
    saved = result.version;
  }
  return { version: saved, route: await routeFor(tx, w, box.address), rule: rules.rule, forward };
}

/**
 * Deleting an address takes its rule attachments with it, in the caller's transaction (which holds the address lane).
 * A two-way rule left running nowhere goes too (the builder made it for this address); any other rule stays,
 * unattached, and a rule shared with another address keeps running there. Its domain leaves evaluateDomains when no
 * rule that asks the AI is left on it. Routes are routing's: detachDestination takes the inbox out of them.
 */
export async function releaseAddress(tx: DbExecutor, c: Ctx, w: string, box: { id: string; addresses: string[] }) {
  const version = await currentVersion(tx, w);
  const before = await currentRules(tx, w), mine = (target: string) => target === box.id || box.addresses.includes(target);
  const detached = new Set(before.config.attachments.filter(a => mine(a.target)).map(a => a.ritual));
  if (!detached.size) return;
  const attachments = before.config.attachments.filter(a => !mine(a.target));
  const gone = before.config.rituals.filter(r => detached.has(r.key) && r.recipe && (SPLITS as readonly string[]).includes(r.recipe.id) && !attachments.some(a => a.ritual === r.key));
  let config: Config = { ...before.config, attachments, rituals: before.config.rituals.filter(r => !gone.includes(r)) };
  if (before.config.rituals.some(r => detached.has(r.key) && asksAi(r)))
    for (const host of new Set(box.addresses.map(a => a.split('@')[1]!.toLowerCase()))) config = await forgetDomain(tx, w, config, host);
  const result = await saveRules(tx, c, w, RitualConfig.parse(config), version);
  await recordAudit(tx, c, { action: 'ritual.attach', workspaceId: w, target: { type: 'address', id: box.id }, before: { version }, after: { version: result.version, detached: [...detached], deleted: gone.map(r => r.key) } });
}

export function registerAddressFlow(app: App) {
  app.openapi(createRoute({
    method: 'patch', path: '/v1/inbound/addresses/{addressId}/flow', operationId: 'setInboundAddressFlow', tags: ['Inbound addresses'], security,
    summary: 'Set where an address’s mail goes',
    description: 'Change where one address’s mail goes, in one version. Changes the route for the address’s own address and its two-way rule together: one transaction and one routing version, so all of it is saved or none of it. Omitted fields stay as they are, a field equal to what is saved writes nothing, and when nothing changes the version stays. deliver replaces only the route’s destinations (a paused route stays paused). Send the version from getInboundOverview or getRouting as If-Match; a stale one is refused with 409 and nothing changes.',
    request: {
      params: z.object({ addressId: InboundAddressId }),
      headers: z.object({ 'if-match': z.string().max(32).optional().describe('Apply only if routes and rules are still at this version, from getInboundOverview, GET /v1/routing or a previous ETag.') }),
      body: json(SetFlow),
    },
    responses: { 200: response(FlowResult), ...errors },
  }), async c => {
    const w = receivingAdmin(c, 'change routes and rules').workspaceId, { addressId } = c.req.valid('param');
    const result = await c.env.db.transaction(async tx => { try {
      await lockMailboxLane(tx, w, 'address');
      const version = await currentVersion(tx, w);
      checkVersion(c, version);
      const box = (await tx.execute<Address>(sql`SELECT id,address FROM mailboxes WHERE workspace_id=${w} AND id=${addressId} AND (delete_after IS NULL OR delete_after>now())`)).rows[0];
      if (!box) throw new ApiError(404, 'NOT_FOUND', 'Receiving address was not found.');
      return await applyFlow(tx, c, w, box, c.req.valid('json'), version);
    } catch (e) { rolledBack(c); throw e; } });
    c.header('ETag', `"${result.version}"`);
    const { forward, ...flow } = result;
    if (forward && !forward.verified) c.get('actor').wakeJobs = 1;
    return c.json({ ...flow, ...(forward ? { forward: { ...await endpointView(c.env, w, endpointRowOf(forward)), confirmation: forward.verified ? 'skipped' as const : 'emailed' as const } } : {}) }, 200);
  });
}
