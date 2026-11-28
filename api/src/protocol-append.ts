import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, logError } from './core/errors.js';
import { id, rowId } from './core/http.js';
import type { Ctx } from './core/types.js';
import { principal } from './mail-gateway.js';
import { boundMailBucket, mailKey, withMailObjects, readMailBytes } from './mail-objects.js';
import { parseInboundMime } from './mailbox-ingest.js';
import {savePreview} from './protocol-preview.js';

/** A client's APPEND (drafts, Sent copies, imports): up to 40 MiB, as much as received mail can be. It streams to the
 *  mail store; migration 356's mailgw_append checks the same bound. */
const MAX = 40 * 1024 * 1024;
const metadata = z
  .object({
    kid: z.string().max(120),
    folder: z.string().max(255),
    date: z.iso.datetime({ offset: true }),
    flags: z.array(z.string().max(64)).max(64),
    size: z.number().int().min(0).max(MAX),
  })
  .strict();
/** Authenticated before reading. Hold at most a 64KiB index prefix while R2 consumes
 * raw octets; verify size and digest in the stream before publishing any UID. */
export async function streamedAppend(c: Ctx, encoded: string, digest: string) {
  const p = metadata.parse(JSON.parse(Buffer.from(encoded, 'base64').toString())),
    rt = c.env;
  if (Number(c.req.header('content-length')) !== p.size)
    throw new ApiError(422, 'INVALID_LENGTH', 'Invalid append length.');
  const auth = principal(rt, 'imap', sql`p.id=${p.kid}`),
    who = (await rt.db.execute<{ w: string; b: string }>(auth)).rows[0];
  if (!who) throw new ApiError(403, 'CREDENTIAL_REVOKED', 'Protocol access denied.');
  const mid = id('msg'),
    key = mailKey(who.w, 'kept', who.b, mid),
    bucket = boundMailBucket(rt) ?? (!rt.config.multiTenant ? 'local:' : null);
  if (!bucket) throw new ApiError(503, 'MAIL_STORE_UNAVAILABLE', 'Mail store unavailable.');
  const prefix = new Uint8Array(Math.min(p.size, 65536)),
    hash = createHash('sha256');
  let bytes = 0;
  const input = c.req.raw.body ?? new Blob([]).stream();
  const stream = input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        if (bytes + chunk.length > p.size) throw new ApiError(413, 'TOO_LARGE', 'Size exceeded.');
        if (bytes < prefix.length) prefix.set(chunk.subarray(0, prefix.length - bytes), bytes);
        bytes += chunk.length;
        hash.update(chunk);
        ctl.enqueue(chunk);
      },
      flush() {
        if (bytes !== p.size || hash.digest('hex') !== digest)
          throw new ApiError(422, 'INVALID_CONTENT', 'Invalid append content.');
      },
    }),
  );
  // A quota is only what the inbox sets (null: none), as for received mail. Over it, the gateway answers [OVERQUOTA].
  const quota = sql`SELECT FROM inbox_state s JOIN mailboxes b ON b.id=s.inbox_id WHERE s.inbox_id=${who.b} AND (b.quota_messages IS NULL OR s.messages<b.quota_messages) AND (b.quota_bytes IS NULL OR s.bytes+${p.size}<=b.quota_bytes)`;
  if (!(await rt.db.execute(quota)).rowCount) throw new ApiError(409, 'OVERQUOTA', 'Append quota exceeded.');
  // Upload before the transaction: a slow or stalled client must not hold the inbox_state lock (which ingest, flags
  // and expunge also take) or a pooled connection. The UID is published only by the short transaction below.
  await withMailObjects(rt, who.w, '', bucket, async (o) => {
    if (bucket === 'local:') {
      await o.put(key, await readMailBytes(stream, p.size, MAX), 'message/rfc822');
    } else {
      await o.put(key, { stream, length: p.size }, 'message/rfc822');
    }
  });
  const discard = () => withMailObjects(rt, who.w, '', bucket, (o) => o.delete([key])).catch((e: unknown) => logError(e, { code: 'APPEND_CLEANUP_FAILED' }, 'warn'));
  const cut = Buffer.from(prefix).indexOf('\r\n\r\n'),
    header = cut < 0 ? null : cut + 4;
  // Set once the callback finishes: a failure after that is the COMMIT, whose outcome is uncertain, so the object stays.
  let settled = false;
  let row: { pairs: number[][]; validity: number; error?: string };
  try {
    const m = header !== null ? await parseInboundMime(prefix.subarray(0, header)) : null;
    row = await rt.db.transaction(async (tx) => {
      settled = false;
      await tx.execute(sql`SELECT FROM inbox_state WHERE workspace_id=${who.w} AND inbox_id=${who.b} FOR UPDATE`);
      if (!(await tx.execute(auth)).rowCount) throw new ApiError(403, 'CREDENTIAL_REVOKED', 'Protocol access denied.');
      if (!(await tx.execute(quota)).rowCount) throw new ApiError(409, 'OVERQUOTA', 'Append quota exceeded.');
      const r = (
        await tx.execute<{ r: { pairs: number[][]; validity: number; error?: string } }>(
          sql`SELECT mailgw_append(${who.w},${who.b},${p.folder},${mid},${rowId('thr')},${m?.messageId ?? null},${m?.subject ?? ''},${m?.from?.address ?? ''},'',${p.date}::timestamptz,${p.size},${bucket},${key},${header === null ? null : JSON.stringify({ headerLength: header })}::jsonb,${sql.param(p.flags)}::text[]) r`,
        )
      ).rows[0]!.r;
      if (r.error) throw new ApiError(409, r.error === 'OVERQUOTA' ? 'OVERQUOTA' : 'APPEND_REFUSED', 'Append refused.');
      if (r.pairs[0]?.[0] === 0) {
        await savePreview(tx, mid, key, prefix, p.size);
        // Keep the addresses decoded, as received mail does, so SEARCH FROM, TO and CC read them from the store
        // (mail-gateway.ts search); verdicts.fields marks a message that has them.
        const people = (list?: { name?: string; address?: string }[]) => JSON.stringify((list ?? []).flatMap(a => a.address ? [{ name: a.name || null, address: a.address.slice(0, 998) }] : []).slice(0, 256));
        await tx.execute(sql`UPDATE mail_messages SET from_name=${m?.from?.name?.slice(0, 998) || null},"to"=${people(m?.to)}::jsonb,cc=${people(m?.cc)}::jsonb,verdicts=verdicts||'{"fields":true}' WHERE workspace_id=${who.w} AND id=${mid}`);
      }
      settled = true;
      return r;
    });
  } catch (e) {
    if (!settled) await discard();
    throw e;
  }
  // A duplicate kept the existing message: this upload is unreferenced.
  if (row.pairs[0]?.[0] === 1) await discard();
  return row;
}
