-- Per-campaign outcome tallies and per-workspace hourly metrics, maintained as insert-only delta rows by statement
-- triggers on sending_emails (the same pattern as audience_list_counts). Readers sum the folded rows and any
-- not-yet-folded deltas in one indexed query, so GET /v1/campaigns, GET /v1/campaigns/{id}, GET /v1/campaigns/{id}/stats,
-- POST /v1/campaigns/{id}/cancel and GET /v1/metrics stay exact at read time in milliseconds instead of scanning
-- millions of sending_emails or joining sending_email_events.
--
-- Why insert-only deltas + bounded folding:
-- - Concurrent dispatcher shards, campaign releases, feedback batches and retention never lock a shared counter row.
-- - Every trigger is a plain INSERT into append-only tables with bigint counts, no lookups, no foreign keys, no unique
--   constraints and no check constraints that can fail or block a send.
-- - Minute upkeep folds each key's delta rows into one in bounded chunks (fold_sending_campaign_tallies,
--   fold_sending_metrics_hourly); daily upkeep recounts exact totals in a single snapshot with no write locks and logs
--   any difference as an error (reconcile_sending_campaign_tallies, reconcile_sending_metrics_hourly).
--
-- Live deploy lock: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on sending_emails and sending_email_events (reads continue,
-- writes wait) from here to COMMIT (~milliseconds, since migration 408 runs the backfill in a separate transaction with
-- no table locks). The lock is requested in 2-second attempts with a 1-second pause between, in the codebase's lock order
-- (sending_emails before sending_email_events), so active dispatch never queues behind this migration for more than 2 s.
--
-- Emergency undo (one statement; reads check pg_trigger and immediately fall back to live queries behind budgetedRead):
--   ALTER TABLE sending_emails DISABLE TRIGGER sending_tally_insert, DISABLE TRIGGER sending_tally_update, DISABLE TRIGGER sending_tally_delete;

DO $$
BEGIN
  FOR attempt IN 1..60 LOOP
    BEGIN
      SET LOCAL lock_timeout = '2s';
      LOCK TABLE sending_emails, sending_email_events IN SHARE ROW EXCLUSIVE MODE;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(1);
    END;
  END LOOP;
  RAISE EXCEPTION 'sending_emails and sending_email_events were busy for 3 minutes. Nothing was changed: run the migration again.' USING ERRCODE = 'lock_not_available';
END $$;

CREATE TABLE sending_campaign_tallies (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL,
  campaign_id text NOT NULL,
  status text NOT NULL,
  simulated boolean NOT NULL,
  email_count bigint NOT NULL DEFAULT 0,
  accepted bigint NOT NULL DEFAULT 0,
  delivered bigint NOT NULL DEFAULT 0,
  bounced bigint NOT NULL DEFAULT 0,
  complained bigint NOT NULL DEFAULT 0,
  opened bigint NOT NULL DEFAULT 0,
  clicked bigint NOT NULL DEFAULT 0,
  failed bigint NOT NULL DEFAULT 0,
  delivery_delayed bigint NOT NULL DEFAULT 0
);
CREATE INDEX sending_campaign_tallies_lookup
  ON sending_campaign_tallies (workspace_id, campaign_id, status, simulated);

CREATE TABLE sending_metrics_hourly (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL,
  region text NOT NULL,
  kind text NOT NULL,
  hour timestamptz NOT NULL,
  emails bigint NOT NULL DEFAULT 0,
  accepted bigint NOT NULL DEFAULT 0,
  delivered bigint NOT NULL DEFAULT 0,
  bounced bigint NOT NULL DEFAULT 0,
  complained bigint NOT NULL DEFAULT 0,
  opened bigint NOT NULL DEFAULT 0,
  clicked bigint NOT NULL DEFAULT 0,
  failed bigint NOT NULL DEFAULT 0,
  delivery_delayed bigint NOT NULL DEFAULT 0,
  simulated bigint NOT NULL DEFAULT 0
);
CREATE INDEX sending_metrics_hourly_lookup
  ON sending_metrics_hourly (workspace_id, hour, region, kind);

-- Keep sending_emails.event_outcomes in sync when events are inserted directly into sending_email_events (as well as via
-- operation_events). Hot paths (dispatcher recordOutcomes, feedback ingestRoutineSesEvents) set event_outcomes inline on
-- sending_emails so this trigger matches 0 rows and adds no extra UPDATE on the hot path.
CREATE FUNCTION record_sending_event_outcomes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH bits AS (
    SELECT n.workspace_id, n.email_id,
      bit_or(CASE n.type
        WHEN 'send' THEN 1
        WHEN 'accepted' THEN 1
        WHEN 'delivery' THEN 3
        WHEN 'bounce' THEN CASE WHEN n.data->>'bounceSubType' = 'EmailValidationSuppressed' THEN 0 ELSE 5 END
        WHEN 'non_permanent_bounce' THEN 129
        WHEN 'complaint' THEN 9
        WHEN 'delivery_delay' THEN 129
        WHEN 'open' THEN 16
        WHEN 'click' THEN 32
        WHEN 'reject' THEN 64
        WHEN 'rendering_failure' THEN 64
        ELSE 0 END) AS bits
    FROM new_events n
    GROUP BY 1, 2
  ), targets AS (
    SELECT e.id, b.bits::smallint AS bits
    FROM sending_emails e
    JOIN bits b ON e.id = b.email_id AND e.workspace_id = b.workspace_id
    WHERE b.bits <> 0 AND (e.event_outcomes | b.bits::smallint) <> e.event_outcomes
    ORDER BY e.id FOR UPDATE OF e
  )
  UPDATE sending_emails e SET event_outcomes = e.event_outcomes | t.bits FROM targets t WHERE e.id = t.id;
  RETURN NULL;
END $$;

CREATE TRIGGER sending_email_events_outcomes AFTER INSERT ON sending_email_events
  REFERENCING NEW TABLE AS new_events FOR EACH STATEMENT EXECUTE FUNCTION record_sending_event_outcomes();

-- operation_events collapses bounce, non_permanent_bounce and validation_suppressed into one public type ('email.bounced'),
-- so migration 088's ELSE 129 fallback misclassified minimal bounce/validation_suppressed payloads as delivery_delayed.
-- When a matching sending_email_events row exists (same workspace_id + id), sending_email_events_outcomes already sets the
-- exact bit from the unambiguous event type; only orphan operation_events rows fall back to this trigger.
CREATE OR REPLACE FUNCTION record_email_event_outcomes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH bits AS (
    SELECT n.workspace_id, n.data->>'emailId' AS email_id,
      bit_or(CASE n.type WHEN 'email.sent' THEN 1 WHEN 'email.delivered' THEN 3
        WHEN 'email.bounced' THEN CASE WHEN n.data->>'bounceSubType'='EmailValidationSuppressed' THEN 0
          WHEN n.data->>'bounceType'='Permanent' THEN 5 ELSE 129 END
        WHEN 'email.complained' THEN 9 WHEN 'email.delivery_delayed' THEN 129 WHEN 'email.opened' THEN 16
        WHEN 'email.clicked' THEN 32 WHEN 'email.rejected' THEN CASE WHEN n.data->>'status' IN ('suppressed','canceled','acceptance_unknown') THEN 0 ELSE 64 END
        WHEN 'email.rendering_failed' THEN 64 ELSE 0 END) AS bits
    FROM new_events n
    WHERE n.data ? 'emailId'
      AND NOT EXISTS (SELECT 1 FROM sending_email_events v WHERE v.workspace_id = n.workspace_id AND v.id = n.id)
    GROUP BY 1, 2
  ), targets AS (
    SELECT e.id, b.bits::smallint AS bits FROM sending_emails e JOIN bits b ON e.id = b.email_id AND e.workspace_id = b.workspace_id
    WHERE b.bits <> 0 AND (e.event_outcomes | b.bits::smallint) <> e.event_outcomes ORDER BY e.id FOR UPDATE OF e
  ) UPDATE sending_emails e SET event_outcomes = e.event_outcomes | t.bits FROM targets t WHERE e.id = t.id;
  RETURN NULL;
END $$;

CREATE FUNCTION sending_tally_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sending_campaign_tallies (
    workspace_id, campaign_id, status, simulated,
    email_count, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed
  )
  SELECT
    workspace_id, campaign_id, status, simulated,
    count(*),
    count(*) FILTER (WHERE NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0)),
    count(*) FILTER (WHERE status = 'delivered' OR (event_outcomes & 2) <> 0),
    count(*) FILTER (WHERE status = 'bounced' OR (event_outcomes & 4) <> 0),
    count(*) FILTER (WHERE status = 'complained' OR (event_outcomes & 8) <> 0),
    count(*) FILTER (WHERE (event_outcomes & 16) <> 0),
    count(*) FILTER (WHERE (event_outcomes & 32) <> 0),
    count(*) FILTER (WHERE status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0),
    count(*) FILTER (WHERE status = 'delayed' OR (event_outcomes & 128) <> 0)
  FROM new_mail
  WHERE campaign_id IS NOT NULL
  GROUP BY 1, 2, 3, 4;

  INSERT INTO sending_metrics_hourly (
    workspace_id, region, kind, hour,
    emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated
  )
  SELECT
    workspace_id, region, coalesce(snapshot->>'kind', ''), date_trunc('hour', created_at, 'UTC'),
    count(*),
    count(*) FILTER (WHERE NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0)),
    count(*) FILTER (WHERE status = 'delivered' OR (event_outcomes & 2) <> 0),
    count(*) FILTER (WHERE status = 'bounced' OR (event_outcomes & 4) <> 0),
    count(*) FILTER (WHERE status = 'complained' OR (event_outcomes & 8) <> 0),
    count(*) FILTER (WHERE (event_outcomes & 16) <> 0),
    count(*) FILTER (WHERE (event_outcomes & 32) <> 0),
    count(*) FILTER (WHERE status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0),
    count(*) FILTER (WHERE status = 'delayed' OR (event_outcomes & 128) <> 0),
    count(*) FILTER (WHERE simulated)
  FROM new_mail
  GROUP BY 1, 2, 3, 4;

  RETURN NULL;
END $$;

CREATE FUNCTION sending_tally_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH diffs AS (
    SELECT workspace_id, campaign_id, status, simulated,
      sum(d_cnt) AS email_count, sum(d_acc) AS accepted, sum(d_del) AS delivered,
      sum(d_bnc) AS bounced, sum(d_cmp) AS complained, sum(d_opn) AS opened,
      sum(d_clk) AS clicked, sum(d_fld) AS failed, sum(d_dly) AS delivery_delayed
    FROM (
      SELECT workspace_id, campaign_id, status, simulated, 1::bigint AS d_cnt,
        (NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0))::int::bigint AS d_acc,
        (status = 'delivered' OR (event_outcomes & 2) <> 0)::int::bigint AS d_del,
        (status = 'bounced' OR (event_outcomes & 4) <> 0)::int::bigint AS d_bnc,
        (status = 'complained' OR (event_outcomes & 8) <> 0)::int::bigint AS d_cmp,
        ((event_outcomes & 16) <> 0)::int::bigint AS d_opn,
        ((event_outcomes & 32) <> 0)::int::bigint AS d_clk,
        (status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0)::int::bigint AS d_fld,
        (status = 'delayed' OR (event_outcomes & 128) <> 0)::int::bigint AS d_dly
      FROM new_mail WHERE campaign_id IS NOT NULL
      UNION ALL
      SELECT workspace_id, campaign_id, status, simulated, -1::bigint,
        -(NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0))::int::bigint,
        -(status = 'delivered' OR (event_outcomes & 2) <> 0)::int::bigint,
        -(status = 'bounced' OR (event_outcomes & 4) <> 0)::int::bigint,
        -(status = 'complained' OR (event_outcomes & 8) <> 0)::int::bigint,
        -((event_outcomes & 16) <> 0)::int::bigint,
        -((event_outcomes & 32) <> 0)::int::bigint,
        -(status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0)::int::bigint,
        -(status = 'delayed' OR (event_outcomes & 128) <> 0)::int::bigint
      FROM old_mail WHERE campaign_id IS NOT NULL
    ) s
    GROUP BY 1, 2, 3, 4
    HAVING sum(d_cnt) <> 0 OR sum(d_acc) <> 0 OR sum(d_del) <> 0 OR sum(d_bnc) <> 0
        OR sum(d_cmp) <> 0 OR sum(d_opn) <> 0 OR sum(d_clk) <> 0 OR sum(d_fld) <> 0 OR sum(d_dly) <> 0
  )
  INSERT INTO sending_campaign_tallies (
    workspace_id, campaign_id, status, simulated,
    email_count, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed
  ) SELECT * FROM diffs;

  WITH diffs AS (
    SELECT workspace_id, region, kind, hour,
      sum(d_cnt) AS emails, sum(d_acc) AS accepted, sum(d_del) AS delivered,
      sum(d_bnc) AS bounced, sum(d_cmp) AS complained, sum(d_opn) AS opened,
      sum(d_clk) AS clicked, sum(d_fld) AS failed, sum(d_dly) AS delivery_delayed, sum(d_sim) AS simulated
    FROM (
      SELECT workspace_id, region, coalesce(snapshot->>'kind', '') AS kind, date_trunc('hour', created_at, 'UTC') AS hour, 1::bigint AS d_cnt,
        (NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0))::int::bigint AS d_acc,
        (status = 'delivered' OR (event_outcomes & 2) <> 0)::int::bigint AS d_del,
        (status = 'bounced' OR (event_outcomes & 4) <> 0)::int::bigint AS d_bnc,
        (status = 'complained' OR (event_outcomes & 8) <> 0)::int::bigint AS d_cmp,
        ((event_outcomes & 16) <> 0)::int::bigint AS d_opn,
        ((event_outcomes & 32) <> 0)::int::bigint AS d_clk,
        (status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0)::int::bigint AS d_fld,
        (status = 'delayed' OR (event_outcomes & 128) <> 0)::int::bigint AS d_dly,
        simulated::int::bigint AS d_sim
      FROM new_mail
      UNION ALL
      SELECT workspace_id, region, coalesce(snapshot->>'kind', ''), date_trunc('hour', created_at, 'UTC'), -1::bigint,
        -(NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0))::int::bigint,
        -(status = 'delivered' OR (event_outcomes & 2) <> 0)::int::bigint,
        -(status = 'bounced' OR (event_outcomes & 4) <> 0)::int::bigint,
        -(status = 'complained' OR (event_outcomes & 8) <> 0)::int::bigint,
        -((event_outcomes & 16) <> 0)::int::bigint,
        -((event_outcomes & 32) <> 0)::int::bigint,
        -(status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0)::int::bigint,
        -(status = 'delayed' OR (event_outcomes & 128) <> 0)::int::bigint,
        -simulated::int::bigint
      FROM old_mail
    ) s
    GROUP BY 1, 2, 3, 4
    HAVING sum(d_cnt) <> 0 OR sum(d_acc) <> 0 OR sum(d_del) <> 0 OR sum(d_bnc) <> 0
        OR sum(d_cmp) <> 0 OR sum(d_opn) <> 0 OR sum(d_clk) <> 0 OR sum(d_fld) <> 0 OR sum(d_dly) <> 0 OR sum(d_sim) <> 0
  )
  INSERT INTO sending_metrics_hourly (
    workspace_id, region, kind, hour,
    emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated
  ) SELECT * FROM diffs;

  RETURN NULL;
END $$;

CREATE FUNCTION sending_tally_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sending_campaign_tallies (
    workspace_id, campaign_id, status, simulated,
    email_count, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed
  )
  SELECT
    workspace_id, campaign_id, status, simulated,
    -count(*),
    -count(*) FILTER (WHERE NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0)),
    -count(*) FILTER (WHERE status = 'delivered' OR (event_outcomes & 2) <> 0),
    -count(*) FILTER (WHERE status = 'bounced' OR (event_outcomes & 4) <> 0),
    -count(*) FILTER (WHERE status = 'complained' OR (event_outcomes & 8) <> 0),
    -count(*) FILTER (WHERE (event_outcomes & 16) <> 0),
    -count(*) FILTER (WHERE (event_outcomes & 32) <> 0),
    -count(*) FILTER (WHERE status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0),
    -count(*) FILTER (WHERE status = 'delayed' OR (event_outcomes & 128) <> 0)
  FROM old_mail
  WHERE campaign_id IS NOT NULL
  GROUP BY 1, 2, 3, 4;

  INSERT INTO sending_metrics_hourly (
    workspace_id, region, kind, hour,
    emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated
  )
  SELECT
    workspace_id, region, coalesce(snapshot->>'kind', ''), date_trunc('hour', created_at, 'UTC'),
    -count(*),
    -count(*) FILTER (WHERE NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0)),
    -count(*) FILTER (WHERE status = 'delivered' OR (event_outcomes & 2) <> 0),
    -count(*) FILTER (WHERE status = 'bounced' OR (event_outcomes & 4) <> 0),
    -count(*) FILTER (WHERE status = 'complained' OR (event_outcomes & 8) <> 0),
    -count(*) FILTER (WHERE (event_outcomes & 16) <> 0),
    -count(*) FILTER (WHERE (event_outcomes & 32) <> 0),
    -count(*) FILTER (WHERE status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0),
    -count(*) FILTER (WHERE status = 'delayed' OR (event_outcomes & 128) <> 0),
    -count(*) FILTER (WHERE simulated)
  FROM old_mail
  GROUP BY 1, 2, 3, 4;

  RETURN NULL;
END $$;

CREATE TRIGGER sending_tally_insert AFTER INSERT ON sending_emails
  REFERENCING NEW TABLE AS new_mail FOR EACH STATEMENT EXECUTE FUNCTION sending_tally_insert();
CREATE TRIGGER sending_tally_update AFTER UPDATE ON sending_emails
  REFERENCING OLD TABLE AS old_mail NEW TABLE AS new_mail FOR EACH STATEMENT EXECUTE FUNCTION sending_tally_update();
CREATE TRIGGER sending_tally_delete AFTER DELETE ON sending_emails
  REFERENCING OLD TABLE AS old_mail FOR EACH STATEMENT EXECUTE FUNCTION sending_tally_delete();

-- Bounded fold of sending_campaign_tallies: collapses up to batch_limit rows belonging to keys with > 1 row (or an
-- all-zero row) into one row per key in a single atomic statement. Concurrent INSERTs never wait on DELETE; readers
-- always see the exact sum before or after commit. Advisory try-lock ensures at most one fold runs at a time.
CREATE FUNCTION fold_sending_campaign_tallies(batch_limit integer DEFAULT 50000)
RETURNS TABLE (removed_rows integer, kept_rows integer, unfolded_rows bigint) LANGUAGE plpgsql AS $$
DECLARE
  removed integer := 0;
  kept integer := 0;
  extra bigint := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(275817, 1) THEN
    RETURN QUERY SELECT 0, 0, 0::bigint;
    RETURN;
  END IF;

  WITH multi AS (
    SELECT workspace_id, campaign_id, status, simulated
    FROM sending_campaign_tallies
    GROUP BY 1, 2, 3, 4
    HAVING count(*) > 1 OR bool_or(
      email_count = 0 AND accepted = 0 AND delivered = 0 AND bounced = 0
      AND complained = 0 AND opened = 0 AND clicked = 0 AND failed = 0 AND delivery_delayed = 0
    )
  ), picked AS (
    SELECT t.id
    FROM sending_campaign_tallies t
    JOIN multi m
      ON m.workspace_id = t.workspace_id AND m.campaign_id = t.campaign_id
     AND m.status = t.status AND m.simulated = t.simulated
    ORDER BY t.id
    LIMIT batch_limit
  ), gone AS (
    DELETE FROM sending_campaign_tallies t
    USING picked p
    WHERE t.id = p.id
    RETURNING t.workspace_id, t.campaign_id, t.status, t.simulated,
      t.email_count, t.accepted, t.delivered, t.bounced, t.complained,
      t.opened, t.clicked, t.failed, t.delivery_delayed
  ), folded AS (
    INSERT INTO sending_campaign_tallies (
      workspace_id, campaign_id, status, simulated,
      email_count, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed
    )
    SELECT workspace_id, campaign_id, status, simulated,
      sum(email_count), sum(accepted), sum(delivered), sum(bounced), sum(complained),
      sum(opened), sum(clicked), sum(failed), sum(delivery_delayed)
    FROM gone
    GROUP BY 1, 2, 3, 4
    HAVING sum(email_count) <> 0 OR sum(accepted) <> 0 OR sum(delivered) <> 0 OR sum(bounced) <> 0
        OR sum(complained) <> 0 OR sum(opened) <> 0 OR sum(clicked) <> 0 OR sum(failed) <> 0 OR sum(delivery_delayed) <> 0
    RETURNING 1
  )
  SELECT (SELECT count(*)::int FROM gone), (SELECT count(*)::int FROM folded) INTO removed, kept;

  SELECT coalesce(sum(cnt - 1), 0)::bigint INTO extra
  FROM (
    SELECT count(*) AS cnt
    FROM sending_campaign_tallies
    GROUP BY workspace_id, campaign_id, status, simulated
    HAVING count(*) > 1
  ) s;

  RETURN QUERY SELECT removed, kept, extra;
END $$;

CREATE FUNCTION fold_sending_metrics_hourly(batch_limit integer DEFAULT 50000)
RETURNS TABLE (removed_rows integer, kept_rows integer, unfolded_rows bigint) LANGUAGE plpgsql AS $$
DECLARE
  removed integer := 0;
  kept integer := 0;
  extra bigint := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(275817, 2) THEN
    RETURN QUERY SELECT 0, 0, 0::bigint;
    RETURN;
  END IF;

  WITH multi AS (
    SELECT workspace_id, region, kind, hour
    FROM sending_metrics_hourly
    GROUP BY 1, 2, 3, 4
    HAVING count(*) > 1 OR bool_or(
      emails = 0 AND accepted = 0 AND delivered = 0 AND bounced = 0
      AND complained = 0 AND opened = 0 AND clicked = 0 AND failed = 0 AND delivery_delayed = 0 AND simulated = 0
    )
  ), picked AS (
    SELECT t.id
    FROM sending_metrics_hourly t
    JOIN multi m
      ON m.workspace_id = t.workspace_id AND m.region = t.region
     AND m.kind = t.kind AND m.hour = t.hour
    ORDER BY t.id
    LIMIT batch_limit
  ), gone AS (
    DELETE FROM sending_metrics_hourly t
    USING picked p
    WHERE t.id = p.id
    RETURNING t.workspace_id, t.region, t.kind, t.hour,
      t.emails, t.accepted, t.delivered, t.bounced, t.complained,
      t.opened, t.clicked, t.failed, t.delivery_delayed, t.simulated
  ), folded AS (
    INSERT INTO sending_metrics_hourly (
      workspace_id, region, kind, hour,
      emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated
    )
    SELECT workspace_id, region, kind, hour,
      sum(emails), sum(accepted), sum(delivered), sum(bounced), sum(complained),
      sum(opened), sum(clicked), sum(failed), sum(delivery_delayed), sum(simulated)
    FROM gone
    GROUP BY 1, 2, 3, 4
    HAVING sum(emails) <> 0 OR sum(accepted) <> 0 OR sum(delivered) <> 0 OR sum(bounced) <> 0
        OR sum(complained) <> 0 OR sum(opened) <> 0 OR sum(clicked) <> 0 OR sum(failed) <> 0
        OR sum(delivery_delayed) <> 0 OR sum(simulated) <> 0
    RETURNING 1
  )
  SELECT (SELECT count(*)::int FROM gone), (SELECT count(*)::int FROM folded) INTO removed, kept;

  SELECT coalesce(sum(cnt - 1), 0)::bigint INTO extra
  FROM (
    SELECT count(*) AS cnt
    FROM sending_metrics_hourly
    GROUP BY workspace_id, region, kind, hour
    HAVING count(*) > 1
  ) s;

  RETURN QUERY SELECT removed, kept, extra;
END $$;

-- Exact single-snapshot recount for one campaign: computes (live sending_emails - stored sending_campaign_tallies) in
-- one statement so writes can run concurrently with no locks on sending_emails. Returns the inserted diff rows (empty
-- when exact; any returned row is a bug logged at error level).
CREATE FUNCTION reconcile_sending_campaign_tallies(wid text, cid text)
RETURNS TABLE (
  status text, simulated boolean,
  email_count bigint, accepted bigint, delivered bigint, bounced bigint,
  complained bigint, opened bigint, clicked bigint, failed bigint, delivery_delayed bigint
) LANGUAGE plpgsql SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(275818, hashtext(wid || ':' || cid));
  RETURN QUERY
  WITH diff AS (
    SELECT s.status, s.simulated,
      sum(s.email_count)::bigint AS email_count, sum(s.accepted)::bigint AS accepted, sum(s.delivered)::bigint AS delivered,
      sum(s.bounced)::bigint AS bounced, sum(s.complained)::bigint AS complained, sum(s.opened)::bigint AS opened,
      sum(s.clicked)::bigint AS clicked, sum(s.failed)::bigint AS failed, sum(s.delivery_delayed)::bigint AS delivery_delayed
    FROM (
      SELECT e.status, e.simulated,
        count(*)::bigint AS email_count,
        count(*) FILTER (WHERE NOT e.simulated AND e.status <> 'suppressed' AND (e.provider_id IS NOT NULL OR e.status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (e.event_outcomes & 1) <> 0))::bigint AS accepted,
        count(*) FILTER (WHERE e.status = 'delivered' OR (e.event_outcomes & 2) <> 0)::bigint AS delivered,
        count(*) FILTER (WHERE e.status = 'bounced' OR (e.event_outcomes & 4) <> 0)::bigint AS bounced,
        count(*) FILTER (WHERE e.status = 'complained' OR (e.event_outcomes & 8) <> 0)::bigint AS complained,
        count(*) FILTER (WHERE (e.event_outcomes & 16) <> 0)::bigint AS opened,
        count(*) FILTER (WHERE (e.event_outcomes & 32) <> 0)::bigint AS clicked,
        count(*) FILTER (WHERE e.status IN ('rejected','rendering_failed') OR (e.event_outcomes & 64) <> 0)::bigint AS failed,
        count(*) FILTER (WHERE e.status = 'delayed' OR (e.event_outcomes & 128) <> 0)::bigint AS delivery_delayed
      FROM sending_emails e
      WHERE e.workspace_id = wid AND e.campaign_id = cid
      GROUP BY 1, 2
      UNION ALL
      SELECT t.status, t.simulated,
        -t.email_count, -t.accepted, -t.delivered, -t.bounced, -t.complained,
        -t.opened, -t.clicked, -t.failed, -t.delivery_delayed
      FROM sending_campaign_tallies t
      WHERE t.workspace_id = wid AND t.campaign_id = cid
    ) s
    GROUP BY 1, 2
    HAVING sum(s.email_count) <> 0 OR sum(s.accepted) <> 0 OR sum(s.delivered) <> 0 OR sum(s.bounced) <> 0
        OR sum(s.complained) <> 0 OR sum(s.opened) <> 0 OR sum(s.clicked) <> 0 OR sum(s.failed) <> 0 OR sum(s.delivery_delayed) <> 0
  )
  INSERT INTO sending_campaign_tallies AS n (
    workspace_id, campaign_id, status, simulated,
    email_count, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed
  )
  SELECT wid, cid, d.status, d.simulated,
    d.email_count, d.accepted, d.delivered, d.bounced, d.complained,
    d.opened, d.clicked, d.failed, d.delivery_delayed
  FROM diff d
  RETURNING n.status, n.simulated, n.email_count, n.accepted, n.delivered, n.bounced,
    n.complained, n.opened, n.clicked, n.failed, n.delivery_delayed;
END $$;

-- Exact single-snapshot recount for one workspace's hourly metrics.
CREATE FUNCTION reconcile_sending_metrics_hourly(wid text)
RETURNS TABLE (
  region text, kind text, hour timestamptz,
  emails bigint, accepted bigint, delivered bigint, bounced bigint,
  complained bigint, opened bigint, clicked bigint, failed bigint, delivery_delayed bigint, simulated bigint
) LANGUAGE plpgsql SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(275819, hashtext(wid));
  RETURN QUERY
  WITH diff AS (
    SELECT s.region, s.kind, s.hour,
      sum(s.emails)::bigint AS emails, sum(s.accepted)::bigint AS accepted, sum(s.delivered)::bigint AS delivered,
      sum(s.bounced)::bigint AS bounced, sum(s.complained)::bigint AS complained, sum(s.opened)::bigint AS opened,
      sum(s.clicked)::bigint AS clicked, sum(s.failed)::bigint AS failed, sum(s.delivery_delayed)::bigint AS delivery_delayed,
      sum(s.simulated)::bigint AS simulated
    FROM (
      SELECT e.region, coalesce(e.snapshot->>'kind', '') AS kind, date_trunc('hour', e.created_at, 'UTC') AS hour,
        count(*)::bigint AS emails,
        count(*) FILTER (WHERE NOT e.simulated AND e.status <> 'suppressed' AND (e.provider_id IS NOT NULL OR e.status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (e.event_outcomes & 1) <> 0))::bigint AS accepted,
        count(*) FILTER (WHERE e.status = 'delivered' OR (e.event_outcomes & 2) <> 0)::bigint AS delivered,
        count(*) FILTER (WHERE e.status = 'bounced' OR (e.event_outcomes & 4) <> 0)::bigint AS bounced,
        count(*) FILTER (WHERE e.status = 'complained' OR (e.event_outcomes & 8) <> 0)::bigint AS complained,
        count(*) FILTER (WHERE (e.event_outcomes & 16) <> 0)::bigint AS opened,
        count(*) FILTER (WHERE (e.event_outcomes & 32) <> 0)::bigint AS clicked,
        count(*) FILTER (WHERE e.status IN ('rejected','rendering_failed') OR (e.event_outcomes & 64) <> 0)::bigint AS failed,
        count(*) FILTER (WHERE e.status = 'delayed' OR (e.event_outcomes & 128) <> 0)::bigint AS delivery_delayed,
        count(*) FILTER (WHERE e.simulated)::bigint AS simulated
      FROM sending_emails e
      WHERE e.workspace_id = wid
      GROUP BY 1, 2, 3
      UNION ALL
      SELECT t.region, t.kind, t.hour,
        -t.emails, -t.accepted, -t.delivered, -t.bounced, -t.complained,
        -t.opened, -t.clicked, -t.failed, -t.delivery_delayed, -t.simulated
      FROM sending_metrics_hourly t
      WHERE t.workspace_id = wid
    ) s
    GROUP BY 1, 2, 3
    HAVING sum(s.emails) <> 0 OR sum(s.accepted) <> 0 OR sum(s.delivered) <> 0 OR sum(s.bounced) <> 0
        OR sum(s.complained) <> 0 OR sum(s.opened) <> 0 OR sum(s.clicked) <> 0 OR sum(s.failed) <> 0
        OR sum(s.delivery_delayed) <> 0 OR sum(s.simulated) <> 0
  )
  INSERT INTO sending_metrics_hourly AS n (
    workspace_id, region, kind, hour,
    emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated
  )
  SELECT wid, d.region, d.kind, d.hour,
    d.emails, d.accepted, d.delivered, d.bounced, d.complained,
    d.opened, d.clicked, d.failed, d.delivery_delayed, d.simulated
  FROM diff d
  RETURNING n.region, n.kind, n.hour, n.emails, n.accepted, n.delivered, n.bounced,
    n.complained, n.opened, n.clicked, n.failed, n.delivery_delayed, n.simulated;
END $$;
