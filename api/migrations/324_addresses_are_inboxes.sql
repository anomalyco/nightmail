SET LOCAL lock_timeout='2s';

-- Every address is an inbox (receiving-8): it has inbox_state and folders, and one SQL writer changes its thread and
-- message state, as for agent inboxes. Existing addresses keep their IDs and are converted in place by convert_addresses,
-- one at a time; a new address is converted as it is inserted (inbox_adopt_new). A temporary address stays what it was:
-- an inbox whose lease is expires_at with no delete_after (kept, receiving stops at expiry). kind='address' keeps what
-- an address may do that an agent inbox may not (start threads, its own send limits).
--
-- Expand only: the Worker this replaces (#360, deployed first) serves while this and convert_addresses run. Every writer
-- takes lanes before rows. Its thread change calls inbox_patch_thread first, which takes the workspace's ingest lane:
-- with inbox_state it writes through the SQL writer, otherwise it keeps the lane while the address writer runs, so
-- inbox_adopt_batch (the lane, then the row FOR UPDATE) waits for it or it for the batch. Claimed mail is filed and
-- counted for any mailbox with inbox_state; its callers hold the address row. Nothing it does needs the fence.

-- The writer fence (140, 152) kept the TypeScript writer off inbox rows during the folder rollout. There is one writer
-- now, so the fence and the marker it read go; each wrapper keeps the ingest lane it takes (148).
DROP TRIGGER inbox_guard_legacy_read ON mailbox_messages;
DROP TRIGGER inbox_guard_legacy_thread ON mailbox_threads;
DROP FUNCTION inbox_guard_legacy_write();

CREATE OR REPLACE FUNCTION inbox_mutate(wid text,bid text,mid text,op text,p jsonb,refresh boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
 IF op='expunge' THEN PERFORM inbox_lock_ingest(wid); END IF;
 PERFORM FROM inbox_state WHERE inbox_id=bid AND workspace_id=wid FOR UPDATE;
 IF NOT EXISTS(SELECT FROM mailboxes WHERE id=bid AND workspace_id=wid AND (delete_after IS NULL OR delete_after>statement_timestamp())) THEN
  result:='{"error":"NOT_FOUND"}';
 ELSE
  result:=inbox_apply_mutation(wid,bid,mid,op,p,refresh);
 END IF;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION inbox_expunge_folder(wid text,bid text,folder text,only_uids bigint[])
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
 PERFORM inbox_lock_ingest(wid);
 RETURN inbox_apply_folder_expunge(wid,bid,folder,only_uids);
END $$;
CREATE OR REPLACE FUNCTION inbox_patch_thread(wid text,bid text,tid text,p jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 PERFORM inbox_lock_ingest(wid);
 RETURN inbox_apply_thread_patch(wid,bid,tid,p);
END $$;
CREATE OR REPLACE FUNCTION mailgw_mutate(w text,b text,src text,dst text,op text,uids bigint[],mode text,bits jsonb,labels text[]) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE e record; data jsonb; result jsonb; pairs jsonb:='[]'; validity bigint; threads text[]:='{}';
BEGIN
 IF op='expunge' THEN PERFORM inbox_lock_ingest(w); END IF;
 IF NOT inbox_lock_visible(w,b,true) THEN RETURN '{"error":"NOT_FOUND"}'; END IF;
 SELECT uid_validity INTO STRICT validity FROM inbox_folders WHERE inbox_id=b AND role=coalesce(dst,src);
 FOR e IN SELECT i.uid,i.deleted,i.message_id,l.labels,l.thread_id,l.held_reason FROM inbox_entries i JOIN mailbox_messages l ON l.mailbox_id=b AND l.message_id=i.message_id WHERE i.inbox_id=b AND i.role=src AND (uids IS NULL OR i.uid=ANY(uids)) AND (op<>'expunge' OR i.deleted) ORDER BY i.uid LOOP
  data:=jsonb_build_object('source',src,'uid',e.uid,'folder',dst);
  IF op='flags' THEN data:=data||bits||jsonb_build_object('addLabels',CASE WHEN mode='remove' THEN ARRAY[]::text[] ELSE labels END,'removeLabels',CASE WHEN mode='replace' THEN ARRAY(SELECT x FROM unnest(e.labels)x WHERE x ~ '^[$a-zA-Z0-9_-]{1,64}$' AND x NOT IN ('unverified','spam','guard-allowed') EXCEPT SELECT unnest(labels)) WHEN mode='remove' THEN labels ELSE ARRAY[]::text[] END); END IF;
  result:=inbox_mutate(w,b,e.message_id,op,data,false);
  IF result?'error' THEN RAISE EXCEPTION 'Protocol batch refused' USING ERRCODE='22023'; END IF;
  IF e.held_reason IS NULL AND e.thread_id IS NOT NULL AND NOT e.thread_id=ANY(threads) THEN threads:=threads||e.thread_id; END IF;
  IF result->>'uid' IS NOT NULL THEN pairs:=pairs||jsonb_build_array(jsonb_build_array(e.uid,result->'uid')); END IF;
 END LOOP;
 PERFORM inbox_refresh_thread(b,t) FROM unnest(threads) t;
 RETURN jsonb_build_object('pairs',pairs,'validity',validity);
END $$;

-- Gives a mailbox inbox_state and files every membership it has, in received order, exactly where
-- inbox_file_delivery(...,legacy=>true) would put each one: its thread's trash, junk or archive state, else Sent or
-- Inbox; starred threads flag their messages. Set-based, so a large address converts in one statement. Returns the
-- number of memberships filed, or NULL when the mailbox is gone or already has inbox_state.
-- Callers hold the mailbox row (or just inserted it), and for an existing mailbox its workspace's ingest lane first.
CREATE FUNCTION inbox_adopt(bid text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE base bigint; n_filed int;
BEGIN
 INSERT INTO inbox_state(inbox_id,workspace_id,messages,bytes)
  SELECT b.id,b.workspace_id,(SELECT count(*) FROM mailbox_messages WHERE mailbox_id=b.id),
   (SELECT coalesce(sum(m.size_bytes),0) FROM mailbox_messages l JOIN mail_messages m ON m.id=l.message_id WHERE l.mailbox_id=b.id)
  FROM mailboxes b WHERE b.id=bid ON CONFLICT(inbox_id) DO NOTHING RETURNING modseq INTO base;
 IF base IS NULL THEN RETURN NULL; END IF;
 WITH ordered AS MATERIALIZED (
   SELECT l.message_id,l.read,l.received_at,l.held_reason,l.inbox_seq,
    CASE WHEN t.trashed_at IS NOT NULL THEN 'trash' WHEN l.direction='outbound' THEN 'sent'
     WHEN t.spam OR 'spam'=ANY(l.labels) OR (m.spam AND NOT 'guard-allowed'=ANY(l.labels)) THEN 'junk'
     WHEN t.archived THEN 'archive' ELSE 'inbox' END AS dest,coalesce(t.starred,false) AS starred
   FROM mailbox_messages l JOIN mail_messages m ON m.id=l.message_id LEFT JOIN mailbox_threads t ON t.mailbox_id=bid AND t.thread_id=m.thread_id
   WHERE l.mailbox_id=bid AND l.modseq IS NULL ORDER BY l.received_at,l.message_id),
  filed AS MATERIALIZED (SELECT o.*,base+row_number() OVER (ORDER BY o.received_at,o.message_id) AS stamp,
   coalesce(o.inbox_seq,nextval(pg_get_serial_sequence('mailbox_events','seq'))) AS seq FROM ordered o),
  placed AS MATERIALIZED (SELECT f.*,fo.uid_next-1+row_number() OVER (PARTITION BY f.dest ORDER BY f.stamp) AS uid
   FROM filed f JOIN inbox_folders fo ON fo.inbox_id=bid AND fo.role=f.dest WHERE f.held_reason IS NULL),
  entries AS (INSERT INTO inbox_entries(inbox_id,role,uid,message_id,modseq,internal_date) SELECT bid,dest,uid,message_id,stamp,received_at FROM placed),
  folders AS (UPDATE inbox_folders fo SET uid_next=fo.uid_next+p.n,total=fo.total+p.n,unseen=fo.unseen+p.unseen,highest_modseq=greatest(fo.highest_modseq,p.top)
   FROM (SELECT dest,count(*) n,count(*) FILTER (WHERE NOT read) unseen,max(stamp) top FROM placed GROUP BY dest) p WHERE fo.inbox_id=bid AND fo.role=p.dest),
  members AS (UPDATE mailbox_messages l SET modseq=f.stamp,flags=CASE WHEN f.starred THEN 1 ELSE 0 END,inbox_seq=f.seq
   FROM filed f WHERE l.mailbox_id=bid AND l.message_id=f.message_id)
 SELECT count(*) INTO n_filed FROM filed;
 UPDATE inbox_state SET modseq=base+n_filed WHERE inbox_id=bid AND n_filed>0;
 RETURN n_filed;
END $$;

-- A new address is an inbox from its first statement, from either Worker and from ingest creating one (a catch-all):
-- mail claimed or delivered into it later in the transaction is filed by its writer. Agent inboxes are created with
-- their inbox_state (create_managed_inbox).
CREATE FUNCTION inbox_adopt_new() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM inbox_adopt(NEW.id); RETURN NULL; END $$;
CREATE TRIGGER inbox_adopt_new AFTER INSERT ON mailboxes FOR EACH ROW WHEN (NEW.kind='address') EXECUTE FUNCTION inbox_adopt_new();

-- convert_addresses converts every existing address, a page at a time in (workspace, id) order. A page takes one workspace's ingest
-- lane, as ingest does before it locks inbox_state, then each address row FOR UPDATE: an address is converted whole,
-- and nothing that decided on its old state (ingest, a thread change, claimed mail, a delete) is still writing it.
CREATE FUNCTION inbox_adopt_batch(after_key text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE pos jsonb:=CASE WHEN after_key='' THEN '["",""]' ELSE after_key::jsonb END; wid text; bid text; last_id text; filed int:=0; boxes int:=0;
BEGIN
 SELECT b.workspace_id,b.id INTO wid,last_id FROM mailboxes b WHERE (b.workspace_id,b.id)>(pos->>0,pos->>1) AND NOT EXISTS(SELECT FROM inbox_state s WHERE s.inbox_id=b.id)
  ORDER BY b.workspace_id,b.id LIMIT 1;
 IF wid IS NULL THEN RETURN NULL; END IF;
 PERFORM inbox_lock_ingest(wid);
 FOR bid IN SELECT b.id FROM mailboxes b WHERE b.workspace_id=wid AND b.id>=last_id AND NOT EXISTS(SELECT FROM inbox_state s WHERE s.inbox_id=b.id) ORDER BY b.id LOOP
  PERFORM FROM mailboxes WHERE id=bid FOR UPDATE;
  filed:=filed+coalesce(inbox_adopt(bid),0); boxes:=boxes+1; last_id:=bid;
  EXIT WHEN filed>=20000 OR boxes>=500;
 END LOOP;
 RETURN jsonb_build_array(wid,last_id)::text;
END $$;

-- Folder edits (inbox_edit_folder) take any inbox, addresses included. A mail client (persistent) still needs a
-- persistent agent inbox: an address keeps the default retention, which IMAP doesn't serve.
CREATE OR REPLACE FUNCTION inbox_lock_visible(w text,b text,persistent boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 PERFORM FROM inbox_state WHERE workspace_id=w AND inbox_id=b FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 RETURN EXISTS(SELECT FROM mailboxes WHERE workspace_id=w AND id=b AND
   (delete_after IS NULL OR delete_after>statement_timestamp()) AND
   (NOT persistent OR (kind='inbox' AND delete_after IS NULL AND retention_mode='forever')));
END $$;

-- Releasing an address deletes it with its threads, folders and inbox_state; its stored mail is kept. An agent inbox
-- ends as before: it stops receiving and is erased after its grace. One lock order for both: lanes, the row, inbox_state.
CREATE OR REPLACE FUNCTION inbox_end(wid text,bid text) RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE ended timestamptz;
BEGIN
 INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(wid,'ingest'),(wid,'address') ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false;
 IF EXISTS(SELECT FROM mailboxes WHERE workspace_id=wid AND id=bid AND kind='address') THEN
  -- FOR UPDATE now, not a weaker lock the delete must upgrade while a key share holder waits on inbox_state.
  PERFORM FROM mailboxes WHERE workspace_id=wid AND id=bid FOR UPDATE;
  PERFORM FROM inbox_state WHERE inbox_id=bid AND workspace_id=wid FOR UPDATE;
  DELETE FROM mailbox_threads WHERE mailbox_id=bid;
  DELETE FROM mailboxes WHERE workspace_id=wid AND id=bid RETURNING statement_timestamp() INTO ended;
  RETURN ended;
 END IF;
 PERFORM FROM mailboxes WHERE workspace_id=wid AND id=bid FOR NO KEY UPDATE;
 PERFORM FROM inbox_state WHERE inbox_id=bid AND workspace_id=wid FOR UPDATE;
 UPDATE mailboxes SET retention_mode='ephemeral', expires_at=least(expires_at,now()),delete_after=now() WHERE workspace_id=wid AND id=bid AND kind='inbox' RETURNING delete_after INTO ended;
 IF NOT FOUND THEN RETURN NULL; END IF;
 DELETE FROM mailbox_addresses a USING mailboxes b WHERE a.workspace_id=wid AND a.mailbox_id=bid AND b.id=bid AND b.create_request->>'type'<>'sandbox';
 UPDATE mailbox_keys SET expires_at=ended WHERE workspace_id=wid AND inbox_id=bid AND (expires_at IS NULL OR expires_at>ended);
 RETURN ended;
END $$;
