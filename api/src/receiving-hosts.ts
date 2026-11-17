import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { ApiError, id, type Ctx, type DbExecutor } from './core.js';
import { recordAudit } from './audit.js';
import { mailboxDomains, mailboxes } from './db/mailbox.js';
import type { domains } from './db/operations.js';
import { checkMx, expectedMx } from './mailbox-dns.js';
import { queueReconcile } from './mailbox-setup.js';
import { reservedPlatformName } from './domain-claims.js';
import { dnsUnavailable, hostedDomain, recheckJob, type HostedDomain } from './operations.js';
import { establishedHost, inspectReceivingHost, type ReceivingIssue } from './receiving-host.js';
import { claimProjection, hostGraceStart } from './states.js';
import { productName } from './brand.js';

// A domain receives on a set of hosts: its root and any of its subdomains, at once, each added and removed on its own.
// A host is one mailbox_domains row of the domain: the row the domain always had (its own row, no parent_id) or a row
// whose parent_id is that row. Each has its own state (pending until its MX is seen, active, active beside another
// provider's MX, lost for two hours after its MX disappears, removed), its own MX record, catch-all and addresses.
// Adding a host never moves or stops another, so moving is adding the new host and later removing the old one.

type Row = typeof mailboxDomains.$inferSelect;
type Domain = typeof domains.$inferSelect;
export type HostStatusView = 'pending' | 'active' | 'mixed' | 'lost' | 'failed' | 'removed';
export type CatchAll = 'create_address' | 'store';
/** `beside`: always a host of its own, never the domain's own row taking it over (the subdomain operations). */
type AddInput = { name: string; catchAll?: CatchAll; metadata?: Record<string, unknown>; confirm?: boolean; beside?: boolean };
/** Hosts a domain may receive on at once, removed ones not counted. */
export const MAX_HOSTS = 20;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const removed = (status: string) => status === 'disabled' || status === 'disabling';
/** Hosts list in the order they were added, also several added in one transaction. */
const addedAt = sql`clock_timestamp()` as unknown as string;

/** The full host for a name given as a label (acme), a host below the domain (acme.example.com) or the domain itself. */
export function hostName(name: string, domain: string) {
  const value = name.trim().toLowerCase().replace(/\.$/, '');
  const host = value === domain || value.endsWith(`.${domain}`) ? value : `${value}.${domain}`;
  const labels = host === domain ? [] : host.slice(0, -(domain.length + 1)).split('.');
  if (host.length > 253 || labels.some(label => !LABEL.test(label))) throw new ApiError(422, 'RECEIVING_HOST_INVALID', `Use ${domain} or one of its subdomains, such as acme or acme.${domain}.`, 'name');
  return host;
}

type ClaimFacts = Pick<HostedDomain, 'receiving_state' | 'receiving_host' | 'receiving_lost_since' | 'identity'>;
/** One host as the API shows it. Hosted, `claim` keeps the domain's own row's issue and the primary host's MX grace, as every Worker writes them. */
export function hostView(row: Row, addressCount: number, claim?: ClaimFacts | null) {
  const host = row.receivingHost ?? row.name, own = row.parentId === null;
  const issue: ReceivingIssue | null = removed(row.status) ? null : own && claim ? (claim.identity?.issue?.host === host ? claim.identity.issue : null) : row.issue;
  const lost = row.status === 'active' && !!(claim ? hostGraceStart(claim, { host, lost_since: row.lostSince }) : row.lostSince);
  const status: HostStatusView = removed(row.status) ? 'removed' : row.status === 'failed' ? 'failed' : row.status !== 'active' ? 'pending' : lost ? 'lost' : row.mx?.state === 'mixed' ? 'mixed' : 'active';
  return { id: row.id, domainId: row.domainId, name: host, status, catchAll: row.catchAll, dns: [expectedMx(host, row.region)], mx: row.mx ?? null, issue, addressCount, metadata: row.metadata,
    createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() };
}
export type HostView = ReturnType<typeof hostView>;

/** The domain's hosts, its own row first, then by when they were added. */
export async function hostRows(db: DbExecutor, workspaceId: string, domainId: string, lock = false) {
  // Also the hosts an earlier life of the domain left below its own row (a domain added again takes that row back).
  const query = db.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, workspaceId), sql`(${mailboxDomains.domainId}=${domainId} OR ${mailboxDomains.parentId} IN (SELECT o.id FROM mailbox_domains o WHERE o.workspace_id=${workspaceId} AND o.domain_id=${domainId} AND o.parent_id IS NULL))`)).orderBy(sql`${mailboxDomains.parentId} IS NOT NULL`, asc(mailboxDomains.createdAt), asc(mailboxDomains.id));
  return lock ? query.for('update') : query;
}
async function views(db: DbExecutor, rows: Row[], claim?: ClaimFacts | null) {
  const counts = rows.length ? await db.select({ domainId: mailboxes.domainId, count: sql<number>`count(*)::int` }).from(mailboxes).where(inArray(mailboxes.domainId, rows.map(row => row.id))).groupBy(mailboxes.domainId) : [];
  return rows.map(row => hostView(row, counts.find(item => item.domainId === row.id)?.count ?? 0, claim));
}
export async function listHosts(c: Ctx, domain: Pick<Domain, 'id' | 'workspaceId'>, only?: string) {
  const claim = c.env.config.multiTenant ? await hostedDomain(c.env.db, domain.workspaceId, domain.id) : null;
  return views(c.env.db, (await hostRows(c.env.db, domain.workspaceId, domain.id)).filter(row => !only || row.id === only), claim);
}

const saveProjection = (db: DbExecutor, claim: HostedDomain, wid: string, rows: Row[]) => {
  const next = claimProjection(claim, rows.map(row => ({ host: row.receivingHost ?? row.name, status: row.status, lost_since: row.lostSince })));
  return db.execute(sql`UPDATE domain_claims SET receiving_state=${next.receiving_state},receiving_host=${next.receiving_host},receiving_lost_since=${next.receiving_lost_since}::timestamptz
    WHERE workspace_id=${wid} AND name=${claim.name} AND token=${claim.token}`);
};
const wake = (c: Ctx) => { const actor = c.get('actor'); if (actor) actor.wakeJobs = Math.max(actor.wakeJobs ?? 0, 1); };

/**
 * Hosted: adds `name` to the domain's hosts after the same DNS checks as choosing a host (a CNAME, one of Nightmail's own
 * names, another domain's host, a name another workspace claimed or a delegated zone is refused; a host whose mail another
 * provider receives needs confirm). Never moves or stops another host. Before the domain's own row routes, an automatic
 * suggestion with no addresses gives way to the added host instead of staying beside it.
 */
async function addHosted(c: Ctx, wid: string, row: HostedDomain, input: AddInput): Promise<{ view: HostView; created: boolean }> {
  const host = hostName(input.name, row.name);
  if (reservedPlatformName(host, c.env.config)) throw new ApiError(409, 'RECEIVING_HOST_RESERVED', `${host} is one of ${productName}’s own hosts, so it can’t receive mail for ${row.name}.`, 'name');
  const existing = row.hosts.find(h => h.host === host && !removed(h.status));
  if (existing) return { view: (await listHosts(c, { id: row.id, workspaceId: wid }, existing.id))[0]!, created: false };
  if (row.claim_scope === 'account' || row.connection.legacy === false) throw new ApiError(409, 'RECEIVING_UNAVAILABLE', `${row.name} can’t receive mail through ${productName}: it was added for sending only.`);
  if (row.hosts.filter(h => !removed(h.status)).length >= MAX_HOSTS) throw new ApiError(409, 'RECEIVING_HOST_LIMIT', `A domain receives on at most ${MAX_HOSTS} hosts. Remove one first.`, 'name');
  const { mx, issue } = await inspectReceivingHost(c.env.db, row, wid, host, dnsUnavailable);
  if (issue?.code === 'cname') throw new ApiError(409, 'RECEIVING_HOST_CNAME', issue.message, 'name');
  if (issue?.code === 'bane_record') throw new ApiError(409, 'RECEIVING_HOST_RESERVED', issue.message, 'name');
  if (issue?.code === 'host_taken') throw new ApiError(409, 'RECEIVING_HOST_TAKEN', issue.message, 'name');
  if (issue?.code === 'claimed') throw new ApiError(409, 'RECEIVING_HOST_CLAIMED', issue.message, 'name');
  if (issue?.code === 'delegated') throw new ApiError(409, 'RECEIVING_HOST_DELEGATED', issue.message, 'name');
  if (issue && ['foreign_mx', 'split', 'wrong_region', 'null_mx'].includes(issue.code) && !input.confirm)
    throw new ApiError(409, 'RECEIVING_HOST_IN_USE', `Move mail for ${host}? ${issue.message} Send confirm: true to choose it anyway.`, 'name');
  const saved = await c.env.db.transaction(async db => {
    // The claim first, then its hosts: the order every receiving write takes. DNS was read before; the write is fenced on the token.
    const current = await hostedDomain(db, wid, row.id, true);
    if (!current || current.token !== row.token) throw new ApiError(409, 'DOMAIN_CHANGED', 'The domain changed while its DNS was checked. Try again.', undefined, true);
    const rows = await hostRows(db, wid, row.id, true), own = rows.find(r => r.parentId === null);
    const same = rows.find(r => (r.receivingHost ?? r.name) === host);
    if (same && !removed(same.status)) return { row: same, created: false };
    if (rows.filter(r => !removed(r.status)).length >= MAX_HOSTS) throw new ApiError(409, 'RECEIVING_HOST_LIMIT', `A domain receives on at most ${MAX_HOSTS} hosts. Remove one first.`, 'name');
    const facts = { mx, checkedAt: mx.checkedAt, issue, lostSince: null, lastError: null, updatedAt: new Date().toISOString() };
    const keep = (values: Partial<Row>) => ({ ...values, ...(input.catchAll ? { catchAll: input.catchAll } : {}), ...(input.metadata ? { metadata: input.metadata } : {}) });
    let saved: Row;
    if (same) {
      // A removed host comes back with its addresses. The domain's own row then stays where the owner put it back.
      if (same.parentId === null) await db.execute(sql`UPDATE domain_claims SET identity=jsonb_set(coalesce(identity,'{}'::jsonb),'{receivingChoice}',to_jsonb(${host}::text)) WHERE workspace_id=${wid} AND name=${current.name} AND token=${current.token}`);
      [saved] = await db.update(mailboxDomains).set(keep({ ...facts, domainId: row.id, status: 'waiting_for_mx', enabledAt: null })).where(eq(mailboxDomains.id, same.id)).returning() as [Row];
    }
    else if (!own || (!input.beside && !establishedHost(current) && !removed(own.status) && !current.identity?.receivingChoice && !(await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.domainId, own.id)).limit(1)).length)) {
      // The domain's own row: created by its first host, or an automatic suggestion nothing uses yet, which the added
      // host replaces. The choice keeps the suggestion from moving it again.
      await db.execute(sql`UPDATE domain_claims SET identity=jsonb_set(coalesce(identity,'{}'::jsonb),'{receivingChoice}',to_jsonb(${host}::text)) WHERE workspace_id=${wid} AND name=${current.name} AND token=${current.token}`);
      if (own) [saved] = await db.update(mailboxDomains).set(keep({ ...facts, receivingHost: host, status: 'waiting_for_mx', enabledAt: null })).where(eq(mailboxDomains.id, own.id)).returning() as [Row];
      else {
        // A domain added again takes back its old row (and that row's addresses) by name, as the first check would.
        const [created] = await db.execute<Row>(sql`INSERT INTO mailbox_domains AS m(id,workspace_id,domain_id,name,region,receiving_host,status,mx,checked_at,issue,catch_all,metadata)
          VALUES (${id('mdom')},${wid},${row.id},${current.name},${current.region},${host},'waiting_for_mx',${JSON.stringify(mx)}::jsonb,${mx.checkedAt}::timestamptz,${issue ? JSON.stringify(issue) : null}::jsonb,
            ${input.catchAll === 'create_address' ? 'create_mailbox' : 'store'},${JSON.stringify(input.metadata ?? {})}::jsonb)
          ON CONFLICT ON CONSTRAINT mailbox_domains_name DO UPDATE SET domain_id=excluded.domain_id,parent_id=NULL,region=excluded.region,receiving_host=excluded.receiving_host,status=excluded.status,
            mx=excluded.mx,checked_at=excluded.checked_at,issue=excluded.issue,lost_since=NULL,last_error=NULL,enabled_at=NULL,updated_at=now() RETURNING m.id`).then(r => r.rows);
        [saved] = await db.select().from(mailboxDomains).where(eq(mailboxDomains.id, created!.id)) as [Row];
      }
    } else {
      // Another host beside the domain's own row. Its row is named by its ID: its host is receiving_host, and a domain's
      // name stays free for that domain's own row (a workspace may claim both example.com and reply.example.com).
      const hostId = id('mdom');
      [saved] = await db.insert(mailboxDomains).values({ ...keep({ id: hostId, workspaceId: wid, domainId: row.id, parentId: own.id, name: hostId, region: own.region, receivingHost: host, status: 'waiting_for_mx', catchAll: 'store', ...facts }), createdAt: addedAt } as typeof mailboxDomains.$inferInsert).returning() as [Row];
    }
    await saveProjection(db, current, wid, rows.map(r => r.id === saved.id ? saved : r).concat(rows.some(r => r.id === saved.id) ? [] : [saved]));
    // Check it now rather than at the next hourly check: it routes as soon as its MX answers.
    await db.execute(recheckJob(wid, sql`SELECT ${row.id}::text AS id,${current.token}::uuid AS token`));
    await recordAudit(db, c, { action: 'inbound_host.create', workspaceId: wid, target: { type: 'inbound_host', id: saved.id }, after: { domainId: row.id, name: host, catchAll: saved.catchAll, confirm: !!input.confirm, restored: !!same } });
    return { row: saved, created: true };
  }).catch((e: unknown) => {
    const cause = ((e as { cause?: unknown })?.cause ?? e) as { code?: string; constraint?: string };
    if (cause?.code === '23505' && ['mailbox_domains_receiving_host', 'mailbox_domains_routing_host'].includes(cause.constraint ?? '')) throw taken(host, row.name);
    throw e;
  });
  if (saved.created) wake(c);
  return { view: (await views(c.env.db, [saved.row], await hostedDomain(c.env.db, wid, row.id)))[0]!, created: saved.created };
}
const taken = (host: string, name: string) => new ApiError(409, 'RECEIVING_HOST_TAKEN', `${host} already receives mail for another domain, so it can’t also receive for ${name}.`, 'name');

/**
 * Self-hosted: a host below a receiving domain shares its SES identity and receipt rule, which matches every subdomain
 * once the first is added (accept_subdomains), so it receives as soon as its MX points here: no verification of its own.
 * The domain itself is its own row, turned on and off with enableInboundDomain and disableInboundDomain.
 */
async function addSelfHosted(c: Ctx, wid: string, domain: Domain, input: AddInput): Promise<{ view: HostView; created: boolean }> {
  const host = hostName(input.name, domain.name);
  const [own] = (await hostRows(c.env.db, wid, domain.id)).filter(r => r.parentId === null);
  if (!own || !['provisioning', 'waiting_for_mx', 'active'].includes(own.status)) throw new ApiError(409, 'MAILBOX_DOMAIN_NOT_ENABLED', `Enable receiving for ${domain.name} before adding hosts.`);
  if (host === domain.name) return { view: (await views(c.env.db, [own]))[0]!, created: false };
  const mx = await checkMx(host, own.region);
  const result = await c.env.db.transaction(async tx => {
    // One lock per domain row keeps accept_subdomains consistent with its active hosts.
    const [fresh] = await tx.select({ acceptSubdomains: mailboxDomains.acceptSubdomains }).from(mailboxDomains).where(eq(mailboxDomains.id, own.id)).for('no key update');
    const [existing] = await tx.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, wid), eq(mailboxDomains.name, host)));
    if (existing && existing.parentId === own.id && existing.status === 'active') return { row: existing, created: false };
    if (existing && (existing.parentId !== own.id || existing.status === 'active')) throw new ApiError(409, 'SUBDOMAIN_EXISTS', `${host} already receives mail.`, 'name');
    const now = new Date().toISOString(), values = { status: 'active' as const, catchAll: input.catchAll ?? 'store', metadata: input.metadata ?? {}, mx, checkedAt: mx.checkedAt, lastError: null, enabledAt: now, updatedAt: now };
    const [saved] = existing
      ? await tx.update(mailboxDomains).set({ ...values, catchAll: input.catchAll ?? existing.catchAll, metadata: input.metadata ?? existing.metadata }).where(eq(mailboxDomains.id, existing.id)).returning()
      : await tx.insert(mailboxDomains).values({ id: id('mdom'), workspaceId: wid, domainId: own.domainId, parentId: own.id, name: host, region: own.region, ...values, createdAt: addedAt }).returning();
    if (!fresh?.acceptSubdomains) {
      await tx.update(mailboxDomains).set({ acceptSubdomains: true, updatedAt: now }).where(eq(mailboxDomains.id, own.id));
      await queueReconcile(tx, wid, own.region);
    }
    await recordAudit(tx, c, { action: 'inbound_host.create', workspaceId: wid, target: { type: 'inbound_host', id: saved!.id }, after: { domainId: domain.id, name: host, catchAll: saved!.catchAll, restored: !!existing } });
    return { row: saved!, created: true };
  });
  return { view: (await views(c.env.db, [result.row]))[0]!, created: result.created };
}

export async function addHost(c: Ctx, domain: Domain, input: AddInput) {
  if (!c.env.config.multiTenant) return addSelfHosted(c, domain.workspaceId, domain, input);
  const row = await hostedDomain(c.env.db, domain.workspaceId, domain.id);
  if (!row) throw new ApiError(409, 'MAILBOX_DOMAIN_NOT_ENABLED', `Connect ${domain.name} to a sending connection before adding receiving hosts.`);
  return addHosted(c, domain.workspaceId, row, input);
}
/** chooseReceivingHost once the domain receives somewhere: the chosen host is added beside the others. */
export const addChosenHost = (c: Ctx, wid: string, row: HostedDomain, host: string, confirm: boolean) => addHosted(c, wid, row, { name: host, confirm });

/**
 * Stops receiving on one host. Its addresses and stored mail are kept, and adding the host again restores it. Other hosts
 * are untouched. Hosted: the MX record can stay published; mail to it is no longer accepted. Self-hosted: the domain's own
 * host is turned off with its receipt rule (as disableInboundDomain does), and its hosts below it stop with it.
 */
export async function removeHost(c: Ctx, domain: Domain, hostId: string) {
  const wid = domain.workspaceId;
  const result = await c.env.db.transaction(async db => {
    const claim = c.env.config.multiTenant ? await hostedDomain(db, wid, domain.id, true) : undefined;
    const rows = await hostRows(db, wid, domain.id, true), row = rows.find(r => r.id === hostId);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Receiving host was not found.');
    if (removed(row.status)) return row;
    const own = row.parentId === null, now = new Date().toISOString();
    const status = !c.env.config.multiTenant && own && row.status !== 'failed' ? 'disabling' as const : 'disabled' as const;
    const [saved] = await db.update(mailboxDomains).set({ status, lostSince: null, issue: null, enabledAt: null, updatedAt: now }).where(eq(mailboxDomains.id, row.id)).returning() as [Row];
    if (claim) {
      await saveProjection(db, claim, wid, rows.map(r => r.id === saved.id ? saved : r));
      if (claim.connection.kind === 'byo' && ['active', 'provisioning'].includes(row.status)) await queueReconcile(db, wid, row.region);
    } else if (status === 'disabling') await queueReconcile(db, wid, row.region);
    await recordAudit(db, c, { action: 'inbound_host.delete', workspaceId: wid, target: { type: 'inbound_host', id: row.id }, before: { domainId: domain.id, name: row.receivingHost ?? row.name, status: row.status } });
    return saved;
  });
  return (await views(c.env.db, [result], c.env.config.multiTenant ? await hostedDomain(c.env.db, wid, domain.id) : null))[0]!;
}

export async function updateHost(c: Ctx, domain: Domain, hostId: string, input: { catchAll?: CatchAll; metadata?: Record<string, unknown> }) {
  const wid = domain.workspaceId;
  const saved = await c.env.db.transaction(async db => {
    const [row] = await db.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, wid), eq(mailboxDomains.domainId, domain.id), eq(mailboxDomains.id, hostId))).for('no key update');
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Receiving host was not found.');
    const [updated] = await db.update(mailboxDomains).set({ ...(input.catchAll ? { catchAll: input.catchAll } : {}), ...(input.metadata ? { metadata: input.metadata } : {}), updatedAt: new Date().toISOString() }).where(eq(mailboxDomains.id, row.id)).returning();
    await recordAudit(db, c, { action: 'inbound_host.update', workspaceId: wid, target: { type: 'inbound_host', id: row.id }, details: { fields: Object.keys(input) }, before: { catchAll: row.catchAll }, after: { name: row.receivingHost ?? row.name, catchAll: input.catchAll } });
    return updated!;
  });
  return (await views(c.env.db, [saved], c.env.config.multiTenant ? await hostedDomain(c.env.db, wid, domain.id) : null))[0]!;
}
