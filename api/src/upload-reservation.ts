import { sql } from 'drizzle-orm';
import { ApiError } from './core/errors.js';
import { log } from './log.js';
import type { DbExecutor, Runtime } from './core/types.js';
import { enqueue } from './jobs.js';
import { sizeText } from './outbound-content.js';
import { lockSendScope } from './send-scope.js';
import { SEND_LIMITS } from './send-limits.js';

const UPLOAD_PUT_MS = 10 * 60_000;
/**
 * One uploaded file's share of the workspace's stored-file cap (SEND_LIMITS.storedAttachmentBytes, counted in
 * sending_asset_usage): attachments and template assets alike. put() reserves the bytes before the object is written,
 * refusing past the cap, and writes it; claim(db) turns the reservation into the row the caller inserts in the same
 * transaction (whose own trigger keeps counting it); refund() ends a reservation that never became a row and deletes its
 * object. No database connection is held during object storage I/O.
 */
export function uploadReservation(runtime: Runtime, workspaceId: string, reservationId: string, storageKey: string, bytes: Uint8Array, contentType: string) {
  let reserved = false, published = false;
  const take = (db: DbExecutor) => db.execute(sql`DELETE FROM sending_upload_reservations WHERE workspace_id=${workspaceId} AND id=${reservationId} RETURNING 1`);
  return {
    async put() {
      await runtime.db.transaction(async db => {
        await lockSendScope(db, workspaceId);
        const { rows } = await db.execute<{ bytes: string }>(sql`SELECT bytes FROM sending_asset_usage WHERE workspace_id=${workspaceId}`);
        const kept = Number(rows[0]?.bytes ?? 0);
        if (kept + bytes.length > SEND_LIMITS.storedAttachmentBytes) throw new ApiError(413, 'STORED_ATTACHMENT_LIMIT_EXCEEDED', `This workspace keeps ${sizeText(kept)} of uploaded files (attachments and template assets) and this one is ${sizeText(bytes.length)}: together they pass the ${SEND_LIMITS.storedAttachmentBytes / 1024 ** 3} GiB a workspace may keep. Delete attachments no draft or queued email uses (DELETE /v1/attachments/{id}), or template assets no template uses (DELETE /v1/template-assets/{id}).`);
        await db.execute(sql`INSERT INTO sending_upload_reservations(id,workspace_id,storage_key,size) VALUES(${reservationId},${workspaceId},${storageKey},${bytes.length})`);
      });
      reserved = true;
      // S3 cancels the put after ten minutes; an R2 binding put cannot be cancelled. A put that lands after
      // its reservation and tombstone (158) are gone is deleted by the hourly storage reconciliation.
      await runtime.storage.put(storageKey, bytes, contentType, AbortSignal.timeout(UPLOAD_PUT_MS));
    },
    async claim(db: DbExecutor) {
      if (!(await take(db)).rowCount) throw new ApiError(503, 'UPLOAD_EXPIRED', 'Upload reservation expired; retry the upload.', undefined, true);
      // From here the caller's row may commit (even if the response is lost): keep the object.
      published = true;
    },
    async refund() {
      if (!reserved) return;
      // Never delete a published object: once claim took the reservation, the row may have committed even if its
      // response was lost. Any other ending deletes the object, also when the sweeper already took an expired
      // reservation: its deletion can run before a slow put lands. If this never runs (a crash, a DB outage), the
      // reservation's tombstone (158) queues the deletion a day later.
      await runtime.db.transaction(async db => { if ((await take(db)).rowCount || !published) await enqueue(db, { workspaceId, type: 'maintenance.deleteAttachment', payload: { key: storageKey } }); })
        .catch(() => log('warn', { code: 'UPLOAD_RESERVATION_CLEANUP_DEFERRED' }));
    },
  };
}
