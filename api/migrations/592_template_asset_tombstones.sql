SET LOCAL lock_timeout='2s';
-- A template asset upload ends its reservation like an attachment upload (src/upload-reservation.ts), so the reservation's
-- delete trigger (158) leaves a tombstone. Only sending_attachments removed the tombstone when its row was published, so
-- every kept template asset left one, and a day later the cleanup queued a deletion its job then kept back (ATTACHMENT_DELETE_KEPT). Publishing a
-- template asset now removes its tombstone too, and the tombstones of assets already kept are removed.
CREATE OR REPLACE TRIGGER sending_upload_published AFTER INSERT ON template_assets FOR EACH ROW EXECUTE FUNCTION sending_upload_published();
DELETE FROM sending_upload_tombstones t USING template_assets a WHERE a.id=t.id;
