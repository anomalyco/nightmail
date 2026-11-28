import {getTableColumns,sql} from 'drizzle-orm';
import type { DbExecutor } from './core/types.js';
import type {StoreNotice} from './inbox-wake.js';
import {mailMessages,mailAttachments} from './db/mailbox.js';
import {ADDRESS} from './mailbox-store.js';
import {mailJson} from './mailbox-text.js';
import {platformValidationMailbox} from './domain-claims.js';

export type Incoming=Omit<typeof mailMessages.$inferInsert,'threadId'> & {receivedAt:string;subject:string;envelopeTo:string[]};
export type IncomingBatchEntry = {
  m: Incoming;
  files: (typeof mailAttachments.$inferInsert)[];
  verifiedFrom: boolean;
  allowCreate: boolean;
  replyAuthorVerified?: boolean;
  plan?: import('./routing-match.js').RoutingResult | null;
  platformHosts?: string | readonly string[] | null;
  preview?: { prefix: string; complete: boolean };
};

function encodeIncoming(entry: IncomingBatchEntry) {
  const { m, files, verifiedFrom, allowCreate, replyAuthorVerified = false, plan, platformHosts = null, preview } = entry;
  const columns = getTableColumns(mailMessages);
  const row = Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined).map(([k, v]) => [columns[k as keyof typeof columns].name, v]));
  const refs = [...new Set([m.inReplyTo, ...[...(m.references ?? [])].reverse(), m.messageId].filter((s): s is string => !!s))].slice(0, 101);
  // An existing inbox still receives; `valid` only gates automatic address creation for an unknown recipient.
  const envelopes = m.envelopeTo.map((addr, n) => ({ addr, n, valid: ADDRESS.test(addr) && !platformValidationMailbox(addr, platformHosts) }));
  return {
    msg: { ...row, reply_author_verified: replyAuthorVerified },
    files,
    refs,
    envelopes,
    authenticated_from: verifiedFrom,
    can_create: allowCreate,
    plan: plan ?? null,
    prefix: preview?.prefix ?? null,
    complete: preview?.complete ?? false,
  };
}

/** pg_notify in the store's own statement (inbox-wake.ts storeNotice): heard at its commit, for no statement of its own. */
const noticed = (notice?: StoreNotice | null) => notice ? sql`, pg_notify(${notice[0]}, ${notice[1]})` : sql``;

/** One implicit transaction; the routine takes the write lane before the DML snapshot. */
export type StoreOptions = { policy?: string; notice?: StoreNotice | null };
export async function storeIncoming(db:DbExecutor,entry:IncomingBatchEntry,{policy,notice}:StoreOptions={}){
  const e = encodeIncoming(entry);
  return (await db.execute<{queued_count:number;wait_ms:number;hold_ms:number}>(sql`SELECT s.* FROM mail_store_incoming(${mailJson(e.msg)}::jsonb,${mailJson(e.files)}::jsonb,${mailJson(e.refs)}::jsonb,${mailJson(e.envelopes)}::jsonb,${e.authenticated_from},${e.can_create},${e.plan?mailJson(e.plan):null}::jsonb,${policy??null}::jsonb,${e.prefix},${e.complete}) s${noticed(notice)}`)).rows[0]!;
}

/** Stores a workspace's batch of prepared inbound messages under one ingest lane lock and one commit. */
export async function storeIncomingBatch(db: DbExecutor, workspaceId: string, entries: IncomingBatchEntry[], { policy, notice }: StoreOptions = {}) {
  if (!entries.length) return [];
  const encoded = entries.map(encodeIncoming);
  return (await db.execute<{ ses_message_id: string; queued_count: number; wait_ms: number; hold_ms: number }>(
    sql`SELECT s.* FROM mail_store_incoming_batch(${workspaceId}, ${mailJson(encoded)}::jsonb, ${policy ?? null}::jsonb) s${noticed(notice)}`,
  )).rows;
}
