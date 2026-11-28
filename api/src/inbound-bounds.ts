import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { Ctx } from './core/types.js';
import { PAGE_MAX_BYTES, utf8Bytes, withBoundedRead } from './read-bounds.js';

export const INBOUND_ADDRESS_STORE_LIMIT = 100;
export const INBOUND_ADDRESS_PAGE_LIMIT = 20;
export const INBOUND_ADDRESS_NAME_LIMIT = 256;
export const INBOUND_ADDRESS_ADDR_LIMIT = 320;
export const ROUTING_CONFIG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Slices a jsonb array column in SQL to at most `limit` elements.
 * Uses an O(1) jsonb_array_length fast path so ordinary small rows never unnest.
 */
export const sliceJsonbArray = (column: SQLWrapper, limit: number): SQL => sql`CASE
  WHEN jsonb_array_length(${column}) <= ${limit} THEN ${column}
  ELSE coalesce((SELECT jsonb_agg(e ORDER BY ord) FROM (SELECT e, ord FROM jsonb_array_elements(${column}) WITH ORDINALITY t(e, ord) LIMIT ${limit}) s), '[]'::jsonb)
END`;

/** Extracts up to `limit` plain address strings from a jsonb MailAddress[] column in SQL. */
export const sliceAddressStrings = (column: SQLWrapper, limit: number): SQL => sql`coalesce(
  (SELECT jsonb_agg(e->>'address' ORDER BY ord) FROM (SELECT e, ord FROM jsonb_array_elements(${column}) WITH ORDINALITY t(e, ord) LIMIT ${limit}) s),
  '[]'::jsonb
)`;

export type AddressCountKey = 'toCount' | 'ccCount' | 'replyToCount' | 'referencesCount';

/** Exact pre-cap count for a message address/references field, covering both newly capped and older rows. */
export const messageFieldCount = (column: SQLWrapper, verdicts: SQLWrapper, key: AddressCountKey): SQL<number> =>
  sql<number>`greatest(jsonb_array_length(${column}), coalesce((${verdicts}->>${sql.raw(`'${key}'`)})::int, 0))::int`;

/**
 * Keeps the longest prefix of `items` whose JSON serialization fits inside `maxBytes`
 * (always keeping at least one item when non-empty so composite/non-id cursors progress).
 */
export function fitPageByBytes<T>(items: T[], hasMoreFromQuery: boolean, maxBytes = PAGE_MAX_BYTES, overhead = 256): { items: T[]; hasMore: boolean } {
  if (!items.length) return { items: [], hasMore: hasMoreFromQuery };
  let bytes = overhead;
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    const size = utf8Bytes(JSON.stringify(items[i]!)) + (i > 0 ? 1 : 0);
    if (i > 0 && bytes + size > maxBytes) return { items: items.slice(0, count), hasMore: true };
    bytes += size;
    count++;
  }
  return { items, hasMore: hasMoreFromQuery };
}

/** Reserves a per-workspace readPool slot for one non-Response step (e.g. a single longPoll tick, never held across sleep). */
export async function withReadLease<T>(c: Ctx, work: () => Promise<T>, opts: { route: string; workspaceId: string; idleMs?: number; maxMs?: number }): Promise<T | null> {
  let out: T | undefined;
  const res = await withBoundedRead(c, async () => {
    out = await work();
    return new Response(null, { status: 204 });
  }, opts);
  if (res instanceof Response && res.status === 499) return null;
  return out as T;
}
