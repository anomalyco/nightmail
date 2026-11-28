/**
 * Where sending uploads are kept in object storage: the one place that knows their key layout.
 * - An attachment: uploads/<workspace>/<attachment id>. Earlier uploads kept <workspace>/attachments/<id> or
 *   <workspace>/live/attachments/<id>; those keys are still read and deleted, never written.
 * - A template asset: <workspace>/templates/assets/<asset id>. An attachment copied from one keeps the asset's key.
 * The uploads/ prefix belongs to uploads alone: every other key family starts with a workspace ID or a mail class,
 * and no workspace may be named `uploads` (migration 158).
 */
export const UPLOAD_PREFIX = 'uploads/';
export const uploadKey = (workspaceId: string, attachmentId: string) => `${UPLOAD_PREFIX}${workspaceId}/${attachmentId}`;
export const templateAssetKey = (workspaceId: string, assetId: string) => `${workspaceId}/templates/assets/${assetId}`;
const attachmentKeys = (workspaceId: string, attachmentId: string) => [uploadKey(workspaceId, attachmentId), `${workspaceId}/attachments/${attachmentId}`, `${workspaceId}/live/attachments/${attachmentId}`];

/** Whether an attachment's key is one this workspace stored it under: its own upload, or the template asset it was copied from. */
export const ownsUploadKey = (workspaceId: string, file: { id: string; storageKey: string; sourceTemplateAssetId: string | null }) => file.sourceTemplateAssetId
  ? file.storageKey === templateAssetKey(workspaceId, file.sourceTemplateAssetId)
  : attachmentKeys(workspaceId, file.id).includes(file.storageKey);

const OBJECT_ID = /^(attachment|tasset)_[A-Za-z0-9]+$/;
/** The only keys the deletion job deletes: an attachment's or a template asset's, in this workspace. */
export function isDeletableUploadKey(workspaceId: string, key: string) {
  const objectId = key.slice(key.lastIndexOf('/') + 1), kind = OBJECT_ID.exec(objectId)?.[1];
  if (!kind || workspaceId.includes('/')) return false;
  return kind === 'tasset' ? key === templateAssetKey(workspaceId, objectId) : attachmentKeys(workspaceId, objectId).includes(key);
}

const RECONCILED = new RegExp(`^${UPLOAD_PREFIX}[^/]+/attachment_[0-9a-f]{32}$`);
/** The keys the hourly storage reconciliation may take: an attachment upload of the current layout (uploadKey). */
export const isReconciledUploadKey = (key: string) => RECONCILED.test(key);
