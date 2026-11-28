import { and, eq, inArray, sql } from 'drizzle-orm';
import { ApiError, id, type DbExecutor, type Runtime } from './core.js';
import { mailboxAddresses, mailboxes, mailboxWriteLanes, mailMessages, type SendLimits } from './db/mailbox.js';
import { mailText } from './mailbox-text.js';
import { safeMailText } from './inbox-content.js';

export type Scope = { workspaceId: string };
/** SES assigns the wire Message-ID independently of Nightmail's durable receipt. */
export const sesMessageId = (providerId: string, region: string) => `${providerId}@${region === 'us-east-1' ? 'email' : region}.amazonses.com`;
/** ON CONFLICT locks even when its WHERE rejects the update: one trip, no idle tuple churn. */
export async function lockMailboxLane(tx: DbExecutor, workspaceId:string, lane: typeof mailboxWriteLanes.$inferSelect.lane) {
  await tx.execute(sql`INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(${workspaceId},${lane}) ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false`);
}
export const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const utf8 = new TextEncoder();
/**
 * Message-IDs compare without angle brackets or surrounding whitespace; case is preserved (RFC 5322 local parts are case-sensitive).
 * An ID is at most one header line, 998 bytes as stored, which is also what its index holds: a longer one is not an ID.
 */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/<([^<>\s]+)>/);
  const result = (match ? match[1]! : value.trim().replace(/^<|>$/g, '')).trim();
  return result && result.length <= 998 && !/\s/.test(result) && utf8.encode(mailText(result)).length <= 998 ? result : null;
}
export function messageIdListCounted(value: string | null | undefined): { items: string[]; count: number } {
  if (!value) return { items: [], count: 0 };
  const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map(match => match[1]!);
  const list = bracketed.length ? bracketed : value.split(/[\s,]+/).map(item => normalizeMessageId(item)).filter((item): item is string => !!item);
  const unique = [...new Set(list)];
  return { items: unique.slice(-100), count: unique.length };
}
export function messageIdList(value: string | null | undefined): string[] {
  return messageIdListCounted(value).items;
}
export function normalizeSubject(value: string) {
  let subject = value.trim();
  for (let i = 0; i < 10; i++) { const next = subject.replace(/^(?:re|fwd?|aw|wg|sv|vs|antw|rif|tr)(?:\[\d+\])?\s*:\s*/i, '').trim(); if (next === subject) break; subject = next; }
  return subject;
}
/** Plain text without quoted history: drops "> " lines and everything from a reply attribution line. */
export function replyText(text: string | null | undefined): string {
  if (!text) return '';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Attribution lines ("On Tue, Ana <a@b.c> wrote:"), including ones wrapped onto a second line.
    if (/^\s*On\s.{0,300}\swrote:\s*$/i.test(line) || (/^\s*On\s/i.test(line) && /\swrote:\s*$/i.test(lines[i + 1] ?? ''))) break;
    if (/^-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}/i.test(line) || /^_{10,}\s*$/.test(line) || /^From:\s.+/.test(line) && /^(?:Sent|Date):\s/.test(lines[i + 1] ?? '')) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function htmlToPlain(html: string) {
  // Text projection only (not an HTML sanitizer). Each token consumes its
  // input once, including truncated markup and unmatched delimiters.
  let hidden=''; const parts:string[]=[];
  for(const [token] of html.slice(0,512*1024).matchAll(/<[^<>]*>?|[^<]+/g)) {
    if(token[0]!=='<') { if(!hidden) parts.push(token); continue; }
    const tag=/^<(\/?)([a-z][a-z0-9]*)\b/i.exec(token);
    const name=tag?.[2]?.toLowerCase();
    if(hidden){ if(tag?.[1] && name===hidden) hidden=''; continue; }
    if(!tag?.[1] && name && ['script','style','head'].includes(name)) hidden=name;
    parts.push(name==='br' || tag?.[1] && /^(p|div|li|tr|h\d)$/.test(name!)?'\n':' ');
  }
  return parts.join('').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/\s+/g,w=>w.includes('\n')?'\n':' ').trim();
}
export function snippetOf(text: string | null | undefined, html: string | null | undefined) {
  const source = replyText(safeMailText(text ? text.slice(0, 16384) : null, html ? html.slice(0, 16384) : null).text);
  return source.replace(/\s+/g, ' ').trim().slice(0, 200);
}
export function validateRule(rule: string, domain: string) {
  const value = rule.trim().toLowerCase();
  const [local, host] = value.split('@');
  if (!local || !host || value.split('@').length !== 2 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || !/^[a-z0-9*.-]+$/.test(host)) throw new ApiError(422, 'INVALID_RULE', 'Rules look like support+*@example.com or *@help.example.com.', 'rules');
  const concrete = host.replace(/^\*\./, '');
  if (host.includes('*') && !host.startsWith('*.') || concrete.includes('*') || (concrete !== domain && !concrete.endsWith(`.${domain}`))) throw new ApiError(422, 'RULE_DOMAIN_MISMATCH', `Rules must stay within ${domain} or its subdomains.`, 'rules');
  if (/^\*{2,}$/.test(local) || value === `*@${domain}`) throw new ApiError(422, 'RULE_TOO_BROAD', 'A rule cannot claim every address on the domain; use the domain catch-all setting instead.', 'rules');
  return value;
}

export function checkTemporaryMailboxRouting(input: { aliases?: string[]; rules?: string[] }) {
  if (input.aliases?.length || input.rules?.length) throw new ApiError(422, 'TEMPORARY_MAILBOX_ROUTING', 'Temporary mailboxes do not support aliases or wildcard rules.', input.aliases?.length ? 'aliases' : 'rules');
}
export async function checkRuleCapacity(tx:DbExecutor,wid:string,domain:string,except='') {
  if ((await tx.execute(sql`SELECT FROM mailboxes WHERE workspace_id=${wid} AND domain_id=${domain} AND id<>${except} AND expires_at IS NULL AND rules<>'[]'::jsonb ORDER BY created_at,id LIMIT 1 OFFSET 63`)).rowCount)throw new ApiError(409,'MAILBOX_RULE_LIMIT','At most 64 addresses per domain can have wildcard rules.');
}

/** Creates a mailbox with its primary address and aliases. Addresses stay reserved until deletion. */
export async function createMailbox(tx: DbExecutor, scope: Scope, input: { key?:string|null;domainId: string; domainName: string; address: string; displayName?: string | null; aliases?: string[]; rules?: string[]; metadata?: Record<string, unknown>; origin: 'api' | 'auto'; sendLimits?: Partial<SendLimits>; requireDmarc?: boolean; ttlSeconds?: number }) {
  const address = input.address.trim().toLowerCase();
  if (input.ttlSeconds !== undefined) checkTemporaryMailboxRouting(input);
  const aliases = [...new Set((input.aliases ?? []).map(value => value.trim().toLowerCase()))].filter(value => value !== address);
  for (const value of [address, ...aliases]) if (!ADDRESS.test(value) || !value.endsWith(`@${input.domainName}`)) throw new ApiError(422, 'ADDRESS_DOMAIN_MISMATCH', `Addresses must be valid and end in @${input.domainName}.`, 'address');
  const rules = [...new Set((input.rules ?? []).map(rule => validateRule(rule, input.domainName)))];
  if(rules.length)await checkRuleCapacity(tx,scope.workspaceId,input.domainId);
  const all = [address, ...aliases];
  if((await tx.execute(sql`SELECT 1 FROM mail_retired_addresses WHERE workspace_id=${scope.workspaceId} AND address=ANY(${sql.param(all)}::text[]) AND until>now() LIMIT 1`)).rowCount)throw new ApiError(409,'ADDRESS_RETIRED','This address was recently retired.');
  const taken = await tx.select({ address: mailboxAddresses.address }).from(mailboxAddresses).where(and(eq(mailboxAddresses.workspaceId, scope.workspaceId), inArray(mailboxAddresses.address, all)));
  if (taken.length) throw new ApiError(409, 'ADDRESS_TAKEN', `${taken[0]!.address} already belongs to a mailbox.`, 'address');
  const mailboxId = id('mbx');
  // Start the lease after acquiring the address lock, not at transaction start before any wait.
  const lease = input.ttlSeconds === undefined ? {} : { createdAt: sql`statement_timestamp()`, updatedAt: sql`statement_timestamp()`, expiresAt: sql`statement_timestamp() + ${input.ttlSeconds}::int * interval '1 second'` };
  const [row] = await tx.insert(mailboxes).values({ id: mailboxId,key:input.key, ...scope, domainId: input.domainId, address, displayName: input.displayName ?? null, rules, metadata: input.metadata ?? {}, origin: input.origin, sendLimits: input.sendLimits ?? {}, requireDmarc: input.requireDmarc ?? false, ...lease }).returning();
  await tx.insert(mailboxAddresses).values(all.map((value, index) => ({ ...scope, address: value, mailboxId, kind: index === 0 ? 'primary' as const : 'alias' as const })));
  return row!;
}

/**
 * Adds a stored message to mailboxes and updates each mailbox's thread summary. Returns mailboxes that newly received it.
 * Every mailbox is an inbox (it has inbox_state from its insert, migration addresses_are_inboxes): received mail is counted and filed in its
 * folders, as ingest does, and sent mail is filed by the inbox_file_sent trigger.
 */
export async function attachToMailboxes(tx: DbExecutor, scope: Scope, message: Pick<typeof mailMessages.$inferSelect, 'id' | 'direction' | 'threadId' | 'receivedAt' | 'spam' | 'sizeBytes'>, mailboxIds: string[]) {
  if (!mailboxIds.length) return [];
  const inbound = message.direction === 'inbound';
  const result=await tx.execute<{mailbox_id:string;filed:boolean}>(sql`WITH states AS MATERIALIZED (SELECT inbox_id FROM inbox_state WHERE workspace_id=${scope.workspaceId} AND inbox_id=ANY(${sql.param(mailboxIds)}::text[]) ORDER BY inbox_id FOR UPDATE), added AS (
    INSERT INTO mailbox_messages(mailbox_id,message_id,workspace_id,thread_id,direction,read,received_at)
    SELECT box,${message.id},${scope.workspaceId},${message.threadId},${message.direction},${!inbound},${message.receivedAt}::timestamptz FROM jsonb_array_elements_text(${JSON.stringify(mailboxIds)}::jsonb) b(box) WHERE (SELECT count(*) FROM states)>=0 ORDER BY box ON CONFLICT DO NOTHING RETURNING *
  ) INSERT INTO mailbox_threads AS t(mailbox_id,thread_id,workspace_id,message_count,unread_count,last_message_at,last_inbound_at,spam,labels)
    SELECT mailbox_id,thread_id,workspace_id,1,${inbound?1:0},received_at,CASE WHEN ${inbound} THEN received_at END,${message.spam},CASE WHEN ${message.spam} THEN ARRAY['spam'] ELSE ARRAY[]::text[] END FROM added ORDER BY mailbox_id
    ON CONFLICT(mailbox_id,thread_id) DO UPDATE SET message_count=t.message_count+1,unread_count=t.unread_count+excluded.unread_count,last_message_at=greatest(t.last_message_at,excluded.last_message_at),last_inbound_at=greatest(t.last_inbound_at,excluded.last_inbound_at),archived=CASE WHEN excluded.last_inbound_at IS NOT NULL THEN false ELSE t.archived END RETURNING mailbox_id,mailbox_id IN (SELECT inbox_id FROM states) AS filed`);
  const filed = result.rows.filter(row => row.filed).map(row => row.mailbox_id).sort();
  if (inbound && filed.length) {
    await tx.execute(sql`UPDATE inbox_state SET messages=messages+1,bytes=bytes+${message.sizeBytes ?? 0} WHERE inbox_id=ANY(${sql.param(filed)}::text[])`);
    await tx.execute(sql`SELECT inbox_file_delivery(box,${message.id},NULL) FROM unnest(${sql.param(filed)}::text[]) box ORDER BY box`);
  }
  return result.rows.map(row=>row.mailbox_id);
}

export const CLAIM_UNROUTED_INLINE = 100;
export const CLAIM_UNROUTED_BATCH = 200;
export const CLAIM_UNROUTED_MAX_BATCHES = 5;
export const CLAIM_UNROUTED_BUDGET_MS = 2_000;

/**
 * Claims up to `limit` matching rows from `mail_unrouted` into `mailboxId` in a single set-based
 * SQL batch plus one batched `inbox_file_delivery` call. Acquires `inbox_state FOR UPDATE` in its
 * own statement BEFORE reading `mail_unrouted` so the claim always runs on a fresh READ COMMITTED
 * snapshot after waiting on any concurrent writer. Uses `FOR UPDATE OF u SKIP LOCKED` on
 * `mail_unrouted` and deletes claimed rows in the same atomic transaction, so concurrent claimers
 * never attach the same unrouted row twice and an interrupted run loses nothing.
 */
export async function claimUnroutedBatch(
  tx: DbExecutor,
  scope: Scope,
  mailboxId: string,
  addresses: string[],
  rules: string[],
  limit: number,
): Promise<{ picked: number; attached: number }> {
  if (!addresses.length && !rules.length) return { picked: 0, attached: 0 };
  const locked = await tx.execute(sql`SELECT inbox_id FROM inbox_state WHERE workspace_id=${scope.workspaceId} AND inbox_id=${mailboxId} FOR UPDATE`);
  if (!locked.rowCount) return { picked: 0, attached: 0 };
  const unreserved = sql`NOT EXISTS (
    SELECT 1 FROM mailbox_addresses a JOIN mailboxes bm ON bm.id = a.mailbox_id
    WHERE a.workspace_id = u.workspace_id AND (bm.expires_at IS NOT NULL OR a.kind = 'public')
      AND a.address IN (u.address, regexp_replace(u.address, '[+][^@]*@', '@'))
  )`;
  const addrParam = addresses.length ? sql.param(addresses) : null;
  const exactCte = addrParam
    ? sql`SELECT u.address, u.message_id FROM mail_unrouted u
      WHERE u.workspace_id = ${scope.workspaceId} AND u.address = ANY(${addrParam}::text[])
        AND ${unreserved}
      ORDER BY u.address, u.message_id
      LIMIT ${limit}
      FOR UPDATE OF u SKIP LOCKED`
    : sql`SELECT NULL::text AS address, NULL::text AS message_id WHERE false`;
  const plusCte = addrParam
    ? sql`SELECT u.address, u.message_id FROM mail_unrouted u
      WHERE u.workspace_id = ${scope.workspaceId} AND strpos(u.address, '+') > 0
        AND regexp_replace(u.address, '[+][^@]*@', '@') = ANY(${addrParam}::text[])
        AND NOT (u.address = ANY(${addrParam}::text[]))
        AND ${unreserved}
      LIMIT greatest(0, ${limit} - (SELECT count(*)::int FROM exact))
      FOR UPDATE OF u SKIP LOCKED`
    : sql`SELECT NULL::text AS address, NULL::text AS message_id WHERE false`;
  const ruleCte = rules.length
    ? sql`SELECT u.address, u.message_id FROM mail_unrouted u
      WHERE u.workspace_id = ${scope.workspaceId}
        AND EXISTS (SELECT 1 FROM unnest(${sql.param(rules)}::text[]) pat WHERE u.address LIKE replace(replace(replace(replace(pat, '!', '!!'), '%', '!%'), '_', '!_'), '*', '%') ESCAPE '!')
        ${addrParam ? sql`AND NOT (u.address = ANY(${addrParam}::text[]) OR (strpos(u.address, '+') > 0 AND regexp_replace(u.address, '[+][^@]*@', '@') = ANY(${addrParam}::text[])))` : sql``}
        AND ${unreserved}
      LIMIT greatest(0, ${limit} - (SELECT count(*)::int FROM exact) - (SELECT count(*)::int FROM plus))
      FOR UPDATE OF u SKIP LOCKED`
    : sql`SELECT NULL::text AS address, NULL::text AS message_id WHERE false`;
  const { rows: [batch] } = await tx.execute<{ picked: number; attached: string[] }>(sql`
    WITH exact AS MATERIALIZED (${exactCte}),
    plus AS MATERIALIZED (${plusCte}),
    by_rule AS MATERIALIZED (${ruleCte}),
    picked AS MATERIALIZED (
      SELECT p.address, p.message_id, m.thread_id, m.received_at, coalesce(m.size_bytes, 0) AS size_bytes, m.spam
      FROM (
        SELECT address, message_id FROM exact
        UNION ALL SELECT address, message_id FROM plus
        UNION ALL SELECT address, message_id FROM by_rule
      ) p
      JOIN mail_messages m ON m.id = p.message_id AND m.workspace_id = ${scope.workspaceId}
    ),
    distinct_msgs AS MATERIALIZED (
      SELECT DISTINCT ON (message_id) message_id, thread_id, received_at, size_bytes, spam
      FROM picked ORDER BY message_id, received_at
    ),
    added AS (
      INSERT INTO mailbox_messages(mailbox_id, message_id, workspace_id, thread_id, direction, read, received_at)
      SELECT ${mailboxId}, d.message_id, ${scope.workspaceId}, d.thread_id, 'inbound', false, d.received_at
      FROM distinct_msgs d ORDER BY d.received_at, d.message_id
      ON CONFLICT DO NOTHING
      RETURNING message_id, thread_id, received_at
    ),
    threads AS (
      INSERT INTO mailbox_threads AS t(mailbox_id, thread_id, workspace_id, message_count, unread_count, last_message_at, last_inbound_at, spam, labels)
      SELECT ${mailboxId}, a.thread_id, ${scope.workspaceId}, count(*)::int, count(*)::int, max(a.received_at), max(a.received_at),
             (array_agg(d.spam ORDER BY a.received_at, a.message_id))[1], CASE WHEN (array_agg(d.spam ORDER BY a.received_at, a.message_id))[1] THEN ARRAY['spam'] ELSE ARRAY[]::text[] END
      FROM added a JOIN distinct_msgs d ON d.message_id = a.message_id
      GROUP BY a.thread_id
      ON CONFLICT (mailbox_id, thread_id) DO UPDATE SET
        message_count = t.message_count + excluded.message_count,
        unread_count = t.unread_count + excluded.unread_count,
        last_message_at = greatest(t.last_message_at, excluded.last_message_at),
        last_inbound_at = greatest(t.last_inbound_at, excluded.last_inbound_at),
        archived = false
    ),
    state AS (
      UPDATE inbox_state
      SET messages = messages + (SELECT count(*)::int FROM added),
          bytes = bytes + coalesce((SELECT sum(d.size_bytes)::bigint FROM added a JOIN distinct_msgs d ON d.message_id = a.message_id), 0)
      WHERE inbox_id = ${mailboxId} AND EXISTS (SELECT 1 FROM added)
    ),
    gone AS (
      DELETE FROM mail_unrouted u USING picked p
      WHERE u.workspace_id = ${scope.workspaceId} AND u.address = p.address AND u.message_id = p.message_id
      RETURNING 1
    )
    SELECT (SELECT count(*)::int FROM picked) AS picked,
           coalesce(ARRAY(SELECT a.message_id FROM added a ORDER BY a.received_at, a.message_id), ARRAY[]::text[]) AS attached
  `);
  const attached = batch?.attached ?? [];
  if (attached.length) {
    await tx.execute(sql`SELECT inbox_file_delivery(${mailboxId}, mid, NULL) FROM unnest(${sql.param(attached)}::text[]) WITH ORDINALITY t(mid, n) ORDER BY n`);
  }
  return { picked: batch?.picked ?? 0, attached: attached.length };
}

/** Enqueues or refreshes the durable background job that drains remaining unrouted mail for a mailbox. */
export async function queueClaimUnrouted(tx: DbExecutor, workspaceId: string, mailboxId: string) {
  const jobId = `claim-unrouted:${mailboxId}`;
  const queued = await tx.execute<{ status: string }>(sql`
    INSERT INTO jobs(id, type, workspace_id, payload)
    VALUES (${jobId}, 'mailbox.claimUnrouted', ${workspaceId}, jsonb_build_object('mailboxId', ${mailboxId}::text))
    ON CONFLICT (id) DO UPDATE SET
      status = CASE WHEN jobs.status = 'running' THEN 'running' ELSE 'pending' END,
      payload = CASE WHEN jobs.status = 'running' THEN jobs.payload || '{"rescan":true}'::jsonb ELSE excluded.payload END,
      attempts = CASE WHEN jobs.status = 'running' THEN jobs.attempts ELSE 0 END,
      available_at = now(),
      lease_until = CASE WHEN jobs.status = 'running' THEN jobs.lease_until ELSE NULL END,
      last_error = NULL
    RETURNING status
  `);
  if (queued.rows[0]?.status === 'running') {
    await tx.execute(sql`INSERT INTO jobs(id, type, workspace_id, payload) VALUES (public.row_id('job'), 'mailbox.claimUnrouted', ${workspaceId}, jsonb_build_object('mailboxId', ${mailboxId}::text))`);
  }
}

/**
 * Drains remaining unrouted mail for a mailbox in short independent transactions WITHOUT holding
 * the workspace's address write lane. Each batch locks the mailbox FOR SHARE and inbox_state
 * FOR UPDATE, then reads the mailbox's live addresses/rules on a fresh snapshot so deletions,
 * expiry changes, and alias/rule edits are respected immediately.
 */
export async function drainClaimUnrouted(
  runtime: Runtime,
  workspaceId: string,
  mailboxId: string,
  options?: { batchSize?: number; maxBatches?: number; budgetMs?: number },
): Promise<{ done: boolean; claimed: number; batches: number }> {
  const batchSize = options?.batchSize ?? CLAIM_UNROUTED_BATCH;
  const maxBatches = options?.maxBatches ?? CLAIM_UNROUTED_MAX_BATCHES;
  const deadline = Date.now() + (options?.budgetMs ?? CLAIM_UNROUTED_BUDGET_MS);
  let claimed = 0, batches = 0;
  while (batches < maxBatches && Date.now() < deadline) {
    const step = await runtime.db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '10s'`);
      const { rows: [box] } = await tx.execute<{ id: string; rules: string[]; expires_at: string | null; delete_after: string | null }>(sql`
        SELECT id, rules, expires_at::text, delete_after::text
        FROM mailboxes
        WHERE workspace_id = ${workspaceId} AND id = ${mailboxId}
        FOR SHARE`);
      if (!box || box.expires_at !== null || box.delete_after !== null) return { done: true, attached: 0 };
      const addrRows = await tx.execute<{ address: string }>(sql`
        SELECT address FROM mailbox_addresses
        WHERE workspace_id = ${workspaceId} AND mailbox_id = ${mailboxId} AND kind <> 'public'`);
      const addresses = addrRows.rows.map(r => r.address);
      const rules = Array.isArray(box.rules) ? box.rules : [];
      const res = await claimUnroutedBatch(tx, { workspaceId }, mailboxId, addresses, rules, batchSize);
      return { done: res.picked < batchSize, attached: res.attached };
    });
    claimed += step.attached;
    batches++;
    if (step.done) return { done: true, claimed, batches };
  }
  return { done: false, claimed, batches };
}
