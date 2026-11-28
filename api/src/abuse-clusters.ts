import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { bounded, graphLock, isolateItem, workOrder, runnableSeed, lockClusterMembers, type WorkVersion, type AbuseTx, monitoring, rare, utc, workspaceExcluded, type Entity, type Hosted } from './abuse.js';
import { operatorContext, recordAudit } from './audit.js';
import { RATES } from './billing/rates.js';
import { errors, notFound } from './core/errors.js';
import { response, security } from './core/http.js';
import type { App, Ctx } from './core/types.js';
import { operatorActor, type OperatorIdentity } from './operator.js';

// Abuse monitoring, part 2: the groups ("clusters") that accounts and workspaces form when they share enough signals,
// each with a risk score and the reasons behind every point, and the operator API that reads them.
//
// Monitoring only: a score ranks what a person looks at. Nothing here blocks, pauses or limits anyone, nothing on the
// send path reads it; abuse monitoring is monitor-only.
// - Grouping is incremental and bounded: the hourly job (src/abuse.ts) calls refreshClusters for the entities whose
//   links changed, then rescores the clusters longest unscored. A group is found by walking links outward from one
//   entity, a few statements a step, up to a fixed size.
// - A link counts only while both sides still hold a shared value that is still rare (abuse.ts rare), so erased or
//   excluded entities drop out when read, and so does a value that became common after the link was written. Except
//   content: the same message from more and more workspaces is a growing ring, not common infrastructure, so the links
//   written while it was rare keep counting (new ones still stop at the limit).
// - Every read by a person goes through the operator guard and leaves a staff-only access record: who, which
//   cluster, when; never a signal's value.

// How much a shared kind says. An edge needs 1: one strong signal, two medium, or one medium and two weak. A network
// counts as medium only when the two also share a browser. Similar mail is corroboration, never identity on its own.
const STRONG = ['email', 'provider', 'card'], MEDIUM = ['email_alias', 'email_domain', 'send_domain', 'content'], WEAK = ['net', 'link'];
// Fingerprints of sent mail. The free allowance is judged on account and payment signals alone.
const MAIL = ['content', 'link', 'send_domain'];
const MEMBERS_MOST = 40, STEPS_MOST = 6, LINKS_A_STEP = 600, SEEDS_A_RUN = 100, RESCORED_A_RUN = 50;
export const BANDS = ['low', 'watch', 'review', 'high'] as const;
export type Band = (typeof BANDS)[number];
export const bandOf = (score: number): Band => score >= 75 ? 'high' : score >= 50 ? 'review' : score >= 25 ? 'watch' : 'low';
/** Why a cluster scored: a fixed code, its points and the count it was judged on. Never free text. */
export type Reason = { code: string; points: number; count?: number };
export const REASON_CODES = ['MULTI_ACCOUNT', 'FREE_TIER_MULTIPLIED', 'THROWAWAY_SIGNUP', 'SIGNUP_BURST', 'SHARED_CARD', 'PAYMENT_RISK', 'SIMILAR_CONTENT', 'SHARED_LINKS', 'SENDER_STANDING', 'FAST_FIRST_SEND', 'WAITLIST_REPEAT'] as const;

type Key = string;
const keyOf = (entity: Entity): Key => `${entity.type}:${entity.id}`;
const entityOf = (key: Key): Entity => { const at = key.indexOf(':'); return { type: key.slice(0, at) as Entity['type'], id: key.slice(at + 1) }; };
type Edge = { a: Key; b: Key; owner?: true; kinds: Record<string, number>; sameBrowser?: boolean };
const weightOf = (edge: Edge, withoutMail = false) => edge.owner ? 1 : Object.keys(edge.kinds).reduce((sum, kind) => sum + (withoutMail && MAIL.includes(kind) ? 0
  : STRONG.includes(kind) ? 1 : MEDIUM.includes(kind) || (kind === 'net' && edge.sameBrowser) ? .5 : WEAK.includes(kind) ? .25 : 0), 0);
/** Groups of keys joined by the edges that pass `joins`. */
function components(keys: Key[], edges: Edge[], joins: (edge: Edge) => boolean) {
  const parent = new Map(keys.map(key => [key, key]));
  const find = (key: Key): Key => { let root = key; while (parent.get(root) !== root) root = parent.get(root)!; parent.set(key, root); return root; };
  for (const edge of edges) if (joins(edge) && parent.has(edge.a) && parent.has(edge.b)) parent.set(find(edge.a), find(edge.b));
  const groups = new Map<Key, Key[]>();
  for (const key of keys) groups.set(find(key), [...groups.get(find(key)) ?? [], key]);
  return [...groups.values()];
}
const pairsOf = (entities: Entity[]) => sql.join(entities.map(entity => sql`(${entity.type},${entity.id})`), sql`, `);
const idsOf = (entities: Entity[], type: Entity['type']) => sql.param(entities.filter(entity => entity.type === type).map(entity => entity.id));

type Component = { members: Entity[]; edges: Edge[] };
/**
 * The entities reachable from one: along links whose kinds together weigh at least 1, and along ownership (a user and
 * the workspaces they own or sponsor). Each step reads the links and owners of the entities found in the step before;
 * it stops at MEMBERS_MOST entities or STEPS_MOST steps. Excluded users and workspaces are never walked into.
 */
async function gather(runtime: Hosted, seed: Entity): Promise<Component> {
  const members = new Map<Key, Entity>([[keyOf(seed), seed]]), edges = new Map<string, Edge>();
  let frontier = [seed];
  for (let step = 0; step < STEPS_MOST && frontier.length && members.size < MEMBERS_MOST; step++) {
    const found = await bounded(runtime, async tx => {
      const { rows: links } = await tx.execute<{ a_type: Entity['type']; a_id: string; b_type: Entity['type']; b_id: string; kind: string; shared: number; same_browser: boolean }>(sql`SELECT l.a_type,l.a_id,l.b_type,l.b_id,l.kind,l.shared,
          (l.kind='net' AND EXISTS (SELECT FROM abuse_signals x JOIN abuse_signals y ON y.entity_type=l.b_type AND y.entity_id=l.b_id AND y.kind='browser' AND y.value=x.value
            WHERE x.entity_type=l.a_type AND x.entity_id=l.a_id AND x.kind='browser' AND x.value<>'other')) AS same_browser
        FROM identity_links l WHERE ((l.a_type,l.a_id) IN (${pairsOf(frontier)}) OR (l.b_type,l.b_id) IN (${pairsOf(frontier)}))
          AND EXISTS (SELECT FROM abuse_signals x JOIN abuse_signals y ON y.entity_type=l.b_type AND y.entity_id=l.b_id AND y.kind=x.kind AND y.value=x.value
            WHERE x.entity_type=l.a_type AND x.entity_id=l.a_id AND x.kind=l.kind AND (x.kind='content' OR ${rare(sql`x.kind`, sql`x.value`)}))
        ORDER BY l.last_at DESC LIMIT ${LINKS_A_STEP}`);
      const users = idsOf(frontier, 'user'), workspaces = idsOf(frontier, 'workspace');
      const { rows: owned } = await tx.execute<{ user_id: string; workspace_id: string }>(sql`SELECT o.user_id,o.workspace_id FROM (
          SELECT m.user_id,m.workspace_id FROM workspace_members m WHERE m.role='owner' AND (m.user_id=ANY(${users}::text[]) OR m.workspace_id=ANY(${workspaces}::text[]))
          UNION SELECT w.quota_sponsor,w.id FROM workspaces w JOIN nightmail_users u ON u.id=w.quota_sponsor WHERE w.quota_sponsor=ANY(${users}::text[]) OR w.id=ANY(${workspaces}::text[])) o
        WHERE NOT ${workspaceExcluded(sql`o.workspace_id`)} AND NOT EXISTS (SELECT FROM abuse_exclusions x WHERE x.entity_type='user' AND x.entity_id=o.user_id) LIMIT 200`);
      return { links, owned };
    });
    for (const row of found.links) {
      const a = keyOf({ type: row.a_type, id: row.a_id }), b = keyOf({ type: row.b_type, id: row.b_id }), id = `${a}|${b}`, edge = edges.get(id) ?? { a, b, kinds: {} };
      edge.kinds[row.kind] = row.shared;
      if (row.same_browser) edge.sameBrowser = true;
      edges.set(id, edge);
    }
    for (const row of found.owned) { const a = `user:${row.user_id}`, b = `workspace:${row.workspace_id}`; edges.set(`${a}|${b}|owner`, { a, b, owner: true, kinds: {} }); }
    const next: Entity[] = [];
    for (const edge of edges.values()) {
      if (weightOf(edge) < 1) continue;
      for (const [from, to] of [[edge.a, edge.b], [edge.b, edge.a]] as const) if (members.has(from) && !members.has(to) && members.size < MEMBERS_MOST) { members.set(to, entityOf(to)); next.push(entityOf(to)); }
    }
    frontier = next;
  }
  return { members: [...members.values()], edges: [...edges.values()].filter(edge => members.has(edge.a) && members.has(edge.b) && (edge.owner || weightOf(edge) > 0)) };
}

type WorkspaceFacts = { id: string; name: string; created_at: string; position: { mode?: string; freeSentLeft?: number; freeReceivedLeft?: number } | null; exempt: boolean; paid: boolean; step: string | null; daily_limit: number | null;
  sending: string | null; paused: boolean; screened: number; rejected: number; failed_payments: number; disputes: number; fraud_warning: boolean; fast_first_send: boolean };
/** What scoring and the operator's view read about the member workspaces, live: plan, this month's free use, standing, payments. */
async function workspaceFacts(tx: AbuseTx, ids: string[]) {
  if (!ids.length) return [];
  return (await tx.execute<WorkspaceFacts>(sql`SELECT w.id,w.name,${utc(sql`w.created_at`)} AS created_at,billing_position(w.id) AS position,w.exempt_hosted_quotas AS exempt,
      EXISTS (SELECT FROM billing_ledger b WHERE b.workspace_id=w.id AND b.kind='topup') AS paid,s.step,s.daily_limit,pc.kind AS sending,coalesce(pc.paused_at IS NOT NULL,false) AS paused,
      (SELECT coalesce(sum(h.screened),0)::int FROM hosted_screen_hourly h WHERE h.workspace_id=w.id AND h.hour>now()-interval '7 days') AS screened,
      (SELECT coalesce(sum(h.rejected),0)::int FROM hosted_screen_hourly h WHERE h.workspace_id=w.id AND h.hour>now()-interval '7 days') AS rejected,
      (SELECT count(*)::int FROM billing_payment_attempts p WHERE p.workspace_id=w.id AND p.status='failed' AND p.created_at>now()-interval '30 days') AS failed_payments,
      (SELECT count(*)::int FROM billing_ledger b WHERE b.workspace_id=w.id AND b.kind='dispute' AND b.created_at>now()-interval '90 days') AS disputes,
      EXISTS (SELECT FROM billing_blocked_cards c JOIN billing_payment_attempts p ON p.card_fingerprint=c.fingerprint WHERE p.workspace_id=w.id AND c.reason='early_fraud_warning') AS fraud_warning,
      coalesce((SELECT e.created_at<w.created_at+interval '10 minutes' AND e.actor_key_id NOT LIKE 'user\\_%' FROM sending_emails e
        WHERE e.workspace_id=w.id AND w.created_at>now()-interval '30 days' ORDER BY e.created_at LIMIT 1),false) AS fast_first_send
    FROM workspaces w LEFT JOIN sender_standing s ON s.workspace_id=w.id LEFT JOIN provider_connections pc ON pc.workspace_id=w.id WHERE w.id=ANY(${sql.param(ids)}::text[])`)).rows;
}
const freeUse = (facts: WorkspaceFacts) => ({ sent: Math.max(0, RATES.freeSentEmails - (facts.position?.freeSentLeft ?? RATES.freeSentEmails)), received: Math.max(0, RATES.freeReceivedEmails - (facts.position?.freeReceivedLeft ?? RATES.freeReceivedEmails)) });
/** free: on the monthly allowance alone; paid: has bought credit; exempt: not billed (staff, or made free by an operator). */
const planOf = (facts: WorkspaceFacts) => facts.exempt || facts.position?.mode === 'exempt' ? 'exempt' as const : facts.paid ? 'paid' as const : 'free' as const;

type Scored = { accounts: Key[][]; reasons: Reason[]; score: number };
/**
 * The score of a component, 0 to 100: every point belongs to a reason code. Accounts are the groups ownership alone
 * makes (a user with their workspaces; a refused sign-in on its own).
 */
async function score(runtime: Hosted, component: Component): Promise<Scored> {
  const keys = component.members.map(keyOf), accounts = components(keys, component.edges, edge => !!edge.owner), accountOf = new Map(accounts.flatMap((group, i) => group.map(key => [key, i] as const)));
  if (accounts.length < 2) return { accounts, reasons: [], score: 0 };
  const { facts, signals } = await bounded(runtime, async tx => ({
    facts: await workspaceFacts(tx, component.members.filter(member => member.type === 'workspace').map(member => member.id)),
    signals: (await tx.execute<{ entity_type: Entity['type']; entity_id: string; kind: string; value: string; seen: number; first_at: string }>(sql`SELECT entity_type,entity_id,kind,value,seen,first_at::text FROM abuse_signals
      WHERE (entity_type,entity_id) IN (${pairsOf(component.members)}) AND kind IN ('flag','net','asn') LIMIT 8000`)).rows,
  }));
  const across = (kind: string) => component.edges.filter(edge => !edge.owner && edge.kinds[kind] && accountOf.get(edge.a) !== accountOf.get(edge.b));
  const reasons: Reason[] = [], add = (code: (typeof REASON_CODES)[number], points: number, count?: number) => { if (points > 0) reasons.push({ code, points, ...(count === undefined ? {} : { count }) }); };
  add('MULTI_ACCOUNT', Math.min(40, 25 + 5 * (accounts.length - 2)), accounts.length);
  // The free allowance, multiplied: workspaces on the free plan alone, joined by account and payment signals (never by
  // what their mail looks like), whose use this month together reaches one workspace's allowance.
  const byId = new Map(facts.map(f => [f.id, f]));
  let multiplied = 0, multipliedBy = 0;
  for (const group of components(keys, component.edges, edge => weightOf(edge, true) >= 1)) {
    const free = group.filter(key => key.startsWith('workspace:')).map(key => byId.get(key.slice(10))).filter((f): f is WorkspaceFacts => !!f && planOf(f) === 'free');
    if (free.length < 2 || new Set(group.map(key => accountOf.get(key))).size < 2) continue;
    const use = free.map(freeUse), ratio = Math.max(use.reduce((sum, u) => sum + u.sent, 0) / RATES.freeSentEmails, use.reduce((sum, u) => sum + u.received, 0) / RATES.freeReceivedEmails);
    const nearCap = use.filter(u => u.sent >= .8 * RATES.freeSentEmails || u.received >= .8 * RATES.freeReceivedEmails).length;
    const points = (ratio >= 2 ? 30 : ratio >= 1 ? 15 : 0) + (ratio >= 1 && nearCap >= 2 ? 5 : 0);
    if (points > multiplied) { multiplied = points; multipliedBy = free.length; }
  }
  add('FREE_TIER_MULTIPLIED', multiplied, multipliedBy);
  const flagged = (flag: string) => signals.filter(s => s.kind === 'flag' && s.value === flag);
  add('THROWAWAY_SIGNUP', (flagged('disposable_email').length ? 15 : 0) + (across('email_alias').length ? 10 : 0), flagged('disposable_email').length + across('email_alias').length);
  // Sign-ups in a burst: the most accounts first seen on one network, or one network provider, inside 24 hours.
  let burst = 0;
  for (const kind of ['net', 'asn']) for (const value of new Set(signals.filter(s => s.kind === kind).map(s => s.value))) {
    const first = new Map<number, number>();
    for (const s of signals) if (s.kind === kind && s.value === value && s.entity_type !== 'workspace') { const account = accountOf.get(keyOf({ type: s.entity_type, id: s.entity_id }))!, at = Date.parse(s.first_at); first.set(account, Math.min(first.get(account) ?? Infinity, at)); }
    const times = [...first.values()].sort((a, b) => a - b);
    for (let i = 0; i < times.length; i++) burst = Math.max(burst, times.filter(at => at >= times[i]! && at < times[i]! + 86_400_000).length);
  }
  add('SIGNUP_BURST', burst >= 10 ? 25 : burst >= 3 ? 15 : 0, burst);
  add('SHARED_CARD', across('card').length ? 20 : 0, across('card').length);
  const disputed = facts.filter(f => f.disputes > 0 || f.fraud_warning).length, failing = facts.filter(f => f.failed_payments >= 3).length;
  add('PAYMENT_RISK', disputed ? 30 : failing ? 10 : 0, disputed || failing);
  add('SIMILAR_CONTENT', across('content').length ? 20 : 0, across('content').length);
  const links = across('link');
  add('SHARED_LINKS', !links.length ? 0 : links.some(edge => edge.kinds.link! >= 3) ? 10 : 5, links.length);
  const worst = Math.max(0, ...facts.map(f => ({ warn: 10, restrict: 15, pause: 25 } as Record<string, number>)[f.step ?? ''] ?? 0)), refused = facts.filter(f => f.screened >= 20 && f.rejected > .1 * f.screened).length;
  add('SENDER_STANDING', worst + (refused ? 15 : 0), facts.filter(f => ['warn', 'restrict', 'pause'].includes(f.step ?? '')).length + refused);
  add('FAST_FIRST_SEND', facts.some(f => f.fast_first_send) ? 5 : 0, facts.filter(f => f.fast_first_send).length);
  // Refused again: an account's first refusal is the waitlist at work (every sign-up while it is on, admitted later when
  // a place opens), so only the refusals after it count.
  const refusals = flagged('waitlisted').reduce((sum, s) => sum + Math.max(0, s.seen - 1), 0);
  add('WAITLIST_REPEAT', refusals >= 5 ? 5 : 0, refusals);
  return { accounts, reasons, score: Math.min(100, reasons.reduce((sum, reason) => sum + reason.points, 0)) };
}

/** keys: the members as type:id, what an alert records it was about. */
export type ClusterChange = { id: string; score: number; band: Band; reasons: Reason[]; workspaces: string[]; accounts: number; members: number; keys: string[]; previous: { score: number; band: Band; members: number } | null };
/**
 * Groups and scores what one entity belongs to and stores it. The cluster keeps the ID of the oldest stored cluster its
 * members were in; the others merge into it. A component of fewer than two accounts is no cluster: what was stored for
 * it is removed, and the members left over are queued to be grouped again. Returns the stored cluster, or null.
 */
async function recluster(runtime: Hosted, seed: Entity): Promise<ClusterChange | null> {
  const component = await gather(runtime, seed), scored = await score(runtime, component), valid = scored.accounts.length >= 2;
  const members = component.members, workspaces = members.filter(member => member.type === 'workspace').map(member => member.id);
  return bounded(runtime, async tx => {
    const { rows: stored } = await tx.execute<{ id: string; score: number; band: Band; peak: number; members: Entity[] }>(sql`SELECT c.id,c.score,c.band,c.peak,c.members FROM abuse_clusters c
      WHERE c.id IN (SELECT m.cluster_id FROM abuse_cluster_members m WHERE (m.entity_type,m.entity_id) IN (${pairsOf(members)})) ORDER BY c.first_at,c.id FOR UPDATE`);
    const kept = valid ? stored[0] : undefined, left = stored.flatMap(cluster => cluster.members).filter(member => !members.some(m => keyOf(m) === keyOf(member)));
    await lockClusterMembers(tx,[...members,...left]);
    const gone = stored.filter(cluster => cluster.id !== kept?.id).map(cluster => cluster.id);
    if (gone.length) await tx.execute(sql`DELETE FROM abuse_clusters WHERE id=ANY(${sql.param(gone)}::text[])`);
    // Grouped now: the links of what was walked. Members a cluster lost are grouped again from their own links.
    await tx.execute(sql`UPDATE identity_links SET pending=false WHERE pending AND ((a_type,a_id) IN (${pairsOf(members)}) OR (b_type,b_id) IN (${pairsOf(members)}))`);
    if (left.length) await tx.execute(sql`UPDATE identity_links SET pending=true WHERE NOT pending AND ((a_type,a_id) IN (${pairsOf(left)}) OR (b_type,b_id) IN (${pairsOf(left)}))`);
    if (!valid) return null;
    const id = kept?.id ?? `acl_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`, band = bandOf(scored.score);
    const changed = !kept || kept.score !== scored.score || kept.members.length !== members.length;
    await tx.execute(sql`INSERT INTO abuse_clusters(id,score,band,peak,accounts,workspaces,reasons,members,edges) VALUES(${id},${scored.score},${band},${scored.score},${scored.accounts.length},${workspaces.length},
        ${JSON.stringify(scored.reasons)}::jsonb,${JSON.stringify(members)}::jsonb,${JSON.stringify(component.edges)}::jsonb)
      ON CONFLICT (id) DO UPDATE SET score=excluded.score,band=excluded.band,peak=greatest(abuse_clusters.peak,excluded.peak),accounts=excluded.accounts,workspaces=excluded.workspaces,reasons=excluded.reasons,
        members=excluded.members,edges=excluded.edges,scored_at=now(),score_requested_at=NULL,changed_at=CASE WHEN ${changed} THEN now() ELSE abuse_clusters.changed_at END`);
    await tx.execute(sql`DELETE FROM abuse_cluster_members WHERE cluster_id=${id}`);
    await tx.execute(sql`INSERT INTO abuse_cluster_members(entity_type,entity_id,cluster_id) SELECT type,id,${id} FROM jsonb_to_recordset(${JSON.stringify(members)}::jsonb) AS m(type text,id text)`);
    return { id, score: scored.score, band, reasons: scored.reasons, workspaces, accounts: scored.accounts.length, members: members.length, keys: members.map(keyOf), previous: kept ? { score: kept.score, band: kept.band, members: kept.members.length } : null };
  });
}
/**
 * The hourly job's last stage: groups up to SEEDS_A_RUN entities whose links changed, then rescores up to
 * RESCORED_A_RUN clusters, longest unscored first (usage and standing move without any link changing). Stops at the
 * deadline; what is left waits for the next run (`cut`: it stopped for the time, or at SEEDS_A_RUN or RESCORED_A_RUN with
 * work still waiting). Uncommitted work remains outstanding for another turn.
 */
export async function refreshClusters(runtime: Hosted, deadline: number, advanced: () => void = () => {}) {
  const result = { grouped: 0, rescored: 0, cut: null as 'time' | 'limit' | null };
  const pending = sql`WITH seeds AS (SELECT a_type,a_id,min(pending_since) AS due FROM identity_links WHERE pending GROUP BY a_type,a_id)
    SELECT json_build_object('type',a_type,'id',a_id) AS seed,abuse_key(a_type,a_id) AS source_key,${utc(sql`due`)} AS at
    FROM seeds WHERE ${runnableSeed('links',sql`abuse_key(a_type,a_id)`,sql`due`)} ORDER BY ${workOrder('links',sql`abuse_key(a_type,a_id)`,sql`due`)},a_type,a_id LIMIT 1`;
  const due = sql`least(score_requested_at,scored_at+interval '30 minutes')`;
  const stale = sql`SELECT members->0 AS seed,abuse_key(id) AS source_key,${utc(due)} AS at FROM abuse_clusters
    WHERE ${due}<=now() AND ${runnableSeed('scores',sql`abuse_key(id)`,due)} ORDER BY ${workOrder('scores',sql`abuse_key(id)`,due)},id LIMIT 1`;
  for (const [stage,query,limit] of [['links',pending,SEEDS_A_RUN],['scores',stale,RESCORED_A_RUN]] as const) {
    for (let n=0; n<limit; n++) {
      if (Date.now()>=deadline) { result.cut='time'; return result; }
      const outcome = await bounded(runtime,async tx => {
        await graphLock(tx,true);
        const { rows: [row] } = await tx.execute<WorkVersion & { seed: Entity }>(query);
        if (!row) return null;
        const scoped = { ...runtime, tx };
        return isolateItem(tx,stage,row,async () => {
          const change = await recluster(scoped,row.seed);
          if (change) await (await import('./abuse-alerts.js')).noteAlert(scoped,change);
        });
      });
      if (outcome === null) break;
      if (outcome) {
        if (stage==='links') result.grouped++; else result.rescored++;
        advanced();
      }
      if (n+1===limit) result.cut='limit';
    }
  }
  return result;
}

// ----- The operator API --------------------------------------------------------------------------------------------------
const ReasonSchema = z.object({ code: z.string(), points: z.number().int(), count: z.number().int().optional() });
const ClusterSummary = z.object({ id: z.string(), score: z.number().int(), band: z.enum(BANDS), peak: z.number().int(), accounts: z.number().int(), workspaces: z.number().int(), reasons: z.array(ReasonSchema),
  firstAt: z.string(), changedAt: z.string(), scoredAt: z.string() }).openapi('OperatorAbuseCluster');
const Use = z.object({ used: z.number().int(), limit: z.number().int() });
const ClusterDetail = ClusterSummary.extend({
  accounts: z.array(z.object({ key: z.string().describe('A1, A2, …: stable within this answer.'), kind: z.enum(['user', 'refused']).describe('refused: a sign-in that was never admitted.'), userId: z.string().nullable(), email: z.string().nullable(), name: z.string().nullable() })),
  workspaces: z.array(z.object({ id: z.string(), name: z.string(), createdAt: z.string(), account: z.string().nullable(), plan: z.enum(['free', 'paid', 'exempt']), sent: Use, received: Use,
    step: z.string().nullable(), dailyLimit: z.number().int().nullable(), sending: z.string().nullable(), paused: z.boolean() })),
  links: z.array(z.object({ a: z.string(), b: z.string(), owner: z.boolean(), strength: z.enum(['owner', 'strong', 'partial']), kinds: z.array(z.object({ kind: z.string(), shared: z.number().int() })) }))
    .describe('a and b are an account key (A1) or a workspace ID. kinds name what is shared and how many values, never a value.'),
}).openapi('OperatorAbuseClusterDetail');
const summaryColumns = sql`c.id,c.score,c.band,c.peak,c.accounts,c.workspaces,c.reasons,${utc(sql`c.first_at`)} AS "firstAt",${utc(sql`c.changed_at`)} AS "changedAt",${utc(sql`c.scored_at`)} AS "scoredAt"`;
/** The staff-only record of a read, on the operator's own trail: who, what and when (kept 90 days). Never what was shown. */
export const accessed = (c: Ctx, operator: OperatorIdentity, action: 'abuse.list' | 'abuse.cluster_read' | 'abuse.alerts', cluster?: string) => recordAudit(c.env.db, operatorContext(c, { id: operator.userId, role: operator.role, via: 'console', userId: operator.userId }),
  { action, workspaceId: null, target: cluster ? { type: 'abuse_cluster', id: cluster } : null, internal: true, retention: 'access' });

export function registerAbuse(app: App) {
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/abuse/clusters', operationId: 'operatorListAbuseClusters',
    request: { query: z.object({ band: z.enum(BANDS).optional(), member: z.string().max(200).optional().describe('A workspace or user ID: only the cluster it is in.'),
      cursor: z.string().max(100).regex(/^\d{1,3}\|acl_[0-9a-f]{24}$/).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) },
    responses: { 200: response(z.object({ data: z.array(ClusterSummary), nextCursor: z.string().nullable(), counts: z.record(z.enum(BANDS), z.number().int()), alerts: z.number().int().describe('Alerts in the outbox.'), monitoring: z.boolean().describe('Whether abuse monitoring is recording.') })), ...errors } }), async c => {
    const operator = await operatorActor(c, 'operator:read'), q = c.req.valid('query'), [after, afterId] = q.cursor?.split('|') ?? [];
    await accessed(c, operator, 'abuse.list');
    const { rows } = await c.env.db.execute<z.infer<typeof ClusterSummary>>(sql`SELECT ${summaryColumns} FROM abuse_clusters c WHERE true ${q.band ? sql`AND c.band=${q.band}` : sql``}
      ${q.member ? sql`AND c.id IN (SELECT m.cluster_id FROM abuse_cluster_members m WHERE m.entity_id=${q.member} AND m.entity_type IN ('user','workspace'))` : sql``}
      ${after ? sql`AND (c.score,c.id)<(${Number(after)},${afterId})` : sql``} ORDER BY c.score DESC,c.id DESC LIMIT ${q.limit + 1}`);
    const { rows: bands } = await c.env.db.execute<{ band: Band; n: number }>(sql`SELECT band,count(*)::int AS n FROM abuse_clusters GROUP BY band`);
    const { rows: [outbox] } = await c.env.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM abuse_alerts`);
    const page = rows.slice(0, q.limit), last = page.at(-1);
    return c.json({ data: page, nextCursor: rows.length > q.limit && last ? `${last.score}|${last.id}` : null,
      counts: Object.fromEntries(BANDS.map(band => [band, bands.find(row => row.band === band)?.n ?? 0])) as Record<Band, number>, alerts: outbox?.n ?? 0, monitoring: monitoring(c.env.config) }, 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/abuse/clusters/{id}', operationId: 'operatorGetAbuseCluster',
    request: { params: z.object({ id: z.string().regex(/^acl_[0-9a-f]{24}$/) }) }, responses: { 200: response(ClusterDetail), ...errors } }), async c => {
    const operator = await operatorActor(c, 'operator:read'), id = c.req.valid('param').id;
    const { rows: [cluster] } = await c.env.db.execute<Omit<z.infer<typeof ClusterSummary>, 'accounts' | 'workspaces'> & { members: Entity[]; edges: Edge[] }>(sql`SELECT ${summaryColumns},c.members,c.edges FROM abuse_clusters c WHERE c.id=${id}`);
    if (!cluster) notFound('Cluster');
    await accessed(c, operator, 'abuse.cluster_read', id);
    const { members, edges, ...summary } = cluster!, keys = members.map(keyOf);
    // Accounts as ownership makes them, named A1, A2, … in the stored order. A refused sign-in is named only by its
    // account key: the keyed hash it is stored under never leaves the API.
    const groups = components(keys, edges, edge => !!edge.owner), label = new Map<Key, string>(), accounts: z.infer<typeof ClusterDetail>['accounts'] = [];
    const people = members.filter(member => member.type === 'user').map(member => member.id);
    const { rows: users } = people.length ? await c.env.db.execute<{ id: string; email: string | null; name: string }>(sql`SELECT id,email,name FROM nightmail_users WHERE id=ANY(${sql.param(people)}::text[])`) : { rows: [] };
    for (const group of groups) {
      const holder = group.find(key => key.startsWith('user:')) ?? group.find(key => key.startsWith('attempt:'));
      const key = holder ? `A${accounts.length + 1}` : null;
      for (const member of group) if (key) label.set(member, member.startsWith('workspace:') ? member.slice(10) : key);
      if (!holder || !key) continue;
      const user = holder.startsWith('user:') ? users.find(row => row.id === holder.slice(5)) : undefined;
      accounts.push({ key, kind: holder.startsWith('user:') ? 'user' : 'refused', userId: holder.startsWith('user:') ? holder.slice(5) : null, email: user?.email ?? null, name: user?.name ?? null });
      // Other users of the same account (co-owners) are accounts of their own in the answer.
      for (const other of group.filter(member => member.startsWith('user:') && member !== holder)) {
        const more = users.find(row => row.id === other.slice(5));
        accounts.push({ key: `A${accounts.length + 1}`, kind: 'user', userId: other.slice(5), email: more?.email ?? null, name: more?.name ?? null });
        label.set(other, accounts.at(-1)!.key);
      }
    }
    const accountOf = (workspace: Key) => { const group = groups.find(g => g.includes(workspace)); const holder = group?.find(key => !key.startsWith('workspace:')); return holder ? label.get(holder) ?? null : null; };
    const facts = await workspaceFacts(c.env.db, members.filter(member => member.type === 'workspace').map(member => member.id));
    const name = (key: Key) => label.get(key) ?? (key.startsWith('workspace:') ? key.slice(10) : null);
    return c.json({ ...summary, accounts,
      workspaces: facts.map(f => ({ id: f.id, name: f.name, createdAt: f.created_at, account: accountOf(`workspace:${f.id}`), plan: planOf(f), sent: { used: freeUse(f).sent, limit: RATES.freeSentEmails },
        received: { used: freeUse(f).received, limit: RATES.freeReceivedEmails }, step: f.step, dailyLimit: f.daily_limit, sending: f.sending, paused: f.paused })),
      links: edges.flatMap(edge => { const a = name(edge.a), b = name(edge.b); return a && b ? [{ a, b, owner: !!edge.owner, strength: edge.owner ? 'owner' as const : weightOf(edge) >= 1 ? 'strong' as const : 'partial' as const,
        kinds: Object.entries(edge.kinds).map(([kind, shared]) => ({ kind, shared })) }] : []; }) }, 200);
  });
}
