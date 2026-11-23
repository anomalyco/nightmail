-- Convert hosted_health_feedback (on sending_email_events) and hosted_health_suppressed (on sending_emails) from
-- FOR EACH ROW triggers calling hosted_refresh_health(wid, eid) per row to FOR EACH STATEMENT triggers calling one
-- set-based hosted_refresh_health_batch(wids, eids) per statement.
--
-- Why: Every 100-row feedback batch (and every 6-row Hosted dispatcher recordOutcomes batch) previously ran
-- hosted_refresh_health() once per row (100x queries + 100x hosted_health_hourly upserts on the same workspace/hour
-- row). The statement trigger deduplicates (workspace_id, email_id) across the batch, runs one set-based credit diff
-- using index probes (LATERAL + force_custom_plan so stale stats never fall back to a Seq Scan), and aggregates all
-- hourly deltas into one ordered upsert per (workspace_id, epoch, hour).
--
-- Live deploy lock: DROP/CREATE TRIGGER takes SHARE ROW EXCLUSIVE on sending_emails and sending_email_events (codebase
-- lock order: sending_emails first, then sending_email_events) for milliseconds, requested in 2-second attempts with
-- 1-second pauses so active dispatch/feedback never queues behind this migration for more than 2 s. No backfill needed.

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

CREATE FUNCTION hosted_refresh_health_batch(wids text[], eids text[]) RETURNS void LANGUAGE sql
  SET plan_cache_mode = force_custom_plan AS $$
  WITH targets AS MATERIALIZED (
    SELECT DISTINCT t.workspace_id, t.email_id, coalesce(pc.resumed_at, '-infinity') AS epoch
    FROM unnest(wids, eids) AS t(workspace_id, email_id)
    JOIN provider_connections pc ON pc.workspace_id = t.workspace_id AND pc.kind = 'shared'
  ),
  envelopes AS MATERIALIZED (
    SELECT t.workspace_id, t.email_id, t.epoch,
      CASE
        WHEN jsonb_array_length(e.to_addresses) = 1 AND e.cc_addresses = '[]'::jsonb AND e.bcc_addresses = '[]'::jsonb
          THEN CASE WHEN lower(e.to_addresses->>0) LIKE '%@simulator.amazonses.com' THEN 0 ELSE 1 END
        ELSE hosted_real_cost(e.to_addresses || e.cc_addresses || e.bcc_addresses)
      END AS cost,
      coalesce(e.snapshot->>'kind' = 'marketing' OR e.campaign_id IS NOT NULL OR e.snapshot ? 'bulk', false) AS marketing
    FROM targets t
    JOIN sending_emails e ON e.id = t.email_id AND e.workspace_id = t.workspace_id
    WHERE NOT e.simulated
      AND e.status <> 'suppressed'
      AND (e.feedback_topic_arn IS NULL OR EXISTS (SELECT FROM provider_feedback_history h WHERE h.topic_arn = e.feedback_topic_arn AND h.kind = 'shared'))
  ),
  latest AS (
    SELECT e.workspace_id, e.email_id, e.epoch, e.cost,
      CASE WHEN v.type IN ('accepted', 'send') THEN 'accepted' ELSE v.type END AS kind,
      coalesce(h.hash, '') AS dest, max(v.created_at) AS at, bool_or(e.marketing) AS marketing
    FROM envelopes e
    CROSS JOIN LATERAL (
      SELECT v.type, v.created_at, v.recipient_hashes
      FROM sending_email_events v
      WHERE v.workspace_id = e.workspace_id AND v.email_id = e.email_id
        AND NOT v.simulated
        AND v.created_at > e.epoch
        AND v.created_at >= date_trunc('hour', now(), 'UTC') - interval '47 hours'
        AND (v.type IN ('accepted', 'send', 'complaint') OR (v.type = 'bounce' AND v.data->>'bounceType' = 'Permanent'))
        AND (v.recipient_hashes IS NULL OR cardinality(v.recipient_hashes) > 0)
    ) v
    LEFT JOIN LATERAL unnest(v.recipient_hashes) h(hash) ON v.type IN ('bounce', 'complaint')
    WHERE e.cost > 0
    GROUP BY 1, 2, 3, 4, 5, 6
  ),
  ranked AS (
    SELECT *, row_number() OVER (PARTITION BY workspace_id, email_id, kind ORDER BY (dest <> '') DESC, at DESC, dest) AS pos,
      max(at) FILTER (WHERE dest = '') OVER (PARTITION BY workspace_id, email_id, kind) AS unknown_at
    FROM latest
  ),
  counted AS (
    SELECT workspace_id, email_id, epoch,
      date_trunc('hour', CASE WHEN pos = 1 THEN greatest(at, unknown_at) ELSE at END, 'UTC') AS hour,
      coalesce(sum(cost) FILTER (WHERE kind = 'accepted'), 0)::int AS accepted,
      count(*) FILTER (WHERE kind = 'bounce')::int AS bounces,
      count(*) FILTER (WHERE kind = 'complaint')::int AS complaints,
      bool_or(marketing) AS marketing
    FROM ranked
    WHERE dest <> '' OR pos = 1
    GROUP BY 1, 2, 3, 4
  ),
  wanted AS MATERIALIZED (
    SELECT workspace_id, email_id, epoch, hour, accepted, bounces, complaints,
      CASE WHEN marketing THEN accepted ELSE 0 END AS marketing_accepted,
      CASE WHEN marketing THEN bounces ELSE 0 END AS marketing_bounces,
      CASE WHEN marketing THEN complaints ELSE 0 END AS marketing_complaints
    FROM counted
  ),
  old AS MATERIALIZED (
    SELECT c.*
    FROM targets t
    JOIN hosted_health_credits c ON c.workspace_id = t.workspace_id AND c.email_id = t.email_id
  ),
  removed AS (
    DELETE FROM hosted_health_credits c
    USING old o
    WHERE (c.workspace_id, c.email_id, c.epoch, c.hour) = (o.workspace_id, o.email_id, o.epoch, o.hour)
      AND NOT EXISTS (SELECT FROM wanted w WHERE (w.workspace_id, w.email_id, w.epoch, w.hour) = (o.workspace_id, o.email_id, o.epoch, o.hour))
    RETURNING c.*
  ),
  changed AS (
    INSERT INTO hosted_health_credits AS c (
      workspace_id, email_id, epoch, hour,
      accepted, bounces, complaints, marketing_accepted, marketing_bounces, marketing_complaints
    )
    SELECT workspace_id, email_id, epoch, hour,
      accepted, bounces, complaints, marketing_accepted, marketing_bounces, marketing_complaints
    FROM wanted
    ORDER BY workspace_id, email_id, epoch, hour
    ON CONFLICT (workspace_id, email_id, epoch, hour) DO UPDATE
      SET accepted = excluded.accepted, bounces = excluded.bounces, complaints = excluded.complaints,
          marketing_accepted = excluded.marketing_accepted, marketing_bounces = excluded.marketing_bounces,
          marketing_complaints = excluded.marketing_complaints
      WHERE (c.accepted, c.bounces, c.complaints, c.marketing_accepted, c.marketing_bounces, c.marketing_complaints)
         <> (excluded.accepted, excluded.bounces, excluded.complaints, excluded.marketing_accepted, excluded.marketing_bounces, excluded.marketing_complaints)
    RETURNING *
  ),
  deltas AS (
    SELECT workspace_id, epoch, hour,
      sum(a)::bigint AS a, sum(b)::bigint AS b, sum(c)::bigint AS c,
      sum(ma)::bigint AS ma, sum(mb)::bigint AS mb, sum(mc)::bigint AS mc
    FROM (
      SELECT workspace_id, epoch, hour, -accepted AS a, -bounces AS b, -complaints AS c,
        -marketing_accepted AS ma, -marketing_bounces AS mb, -marketing_complaints AS mc
      FROM removed
      UNION ALL
      SELECT n.workspace_id, n.epoch, n.hour,
        n.accepted - coalesce(o.accepted, 0), n.bounces - coalesce(o.bounces, 0), n.complaints - coalesce(o.complaints, 0),
        n.marketing_accepted - coalesce(o.marketing_accepted, 0), n.marketing_bounces - coalesce(o.marketing_bounces, 0),
        n.marketing_complaints - coalesce(o.marketing_complaints, 0)
      FROM changed n LEFT JOIN old o USING (workspace_id, email_id, epoch, hour)
    ) d
    GROUP BY 1, 2, 3
    HAVING sum(a) <> 0 OR sum(b) <> 0 OR sum(c) <> 0 OR sum(ma) <> 0 OR sum(mb) <> 0 OR sum(mc) <> 0
  )
  INSERT INTO hosted_health_hourly AS totals (
    workspace_id, epoch, hour,
    accepted, bounces, complaints, marketing_accepted, marketing_bounces, marketing_complaints
  )
  SELECT workspace_id, epoch, hour, a, b, c, ma, mb, mc
  FROM deltas
  ORDER BY workspace_id, epoch, hour
  ON CONFLICT (workspace_id, epoch, hour) DO UPDATE
    SET accepted = totals.accepted + excluded.accepted,
        bounces = totals.bounces + excluded.bounces,
        complaints = totals.complaints + excluded.complaints,
        marketing_accepted = totals.marketing_accepted + excluded.marketing_accepted,
        marketing_bounces = totals.marketing_bounces + excluded.marketing_bounces,
        marketing_complaints = totals.marketing_complaints + excluded.marketing_complaints
$$;

-- Keep single-email helper delegating to the batch function for any direct callers.
CREATE OR REPLACE FUNCTION hosted_refresh_health(wid text, eid text) RETURNS void LANGUAGE sql AS $$
  SELECT hosted_refresh_health_batch(ARRAY[wid], ARRAY[eid])
$$;

CREATE OR REPLACE FUNCTION hosted_health_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  wids text[];
  eids text[];
BEGIN
  SELECT array_agg(workspace_id), array_agg(email_id) INTO wids, eids
  FROM (
    SELECT DISTINCT n.workspace_id, n.email_id
    FROM new_events n
    WHERE NOT n.simulated
      AND (n.type IN ('accepted', 'send', 'complaint') OR (n.type = 'bounce' AND n.data->>'bounceType' = 'Permanent'))
  ) s;
  IF wids IS NOT NULL THEN
    PERFORM hosted_refresh_health_batch(wids, eids);
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION hosted_health_suppression() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  wids text[];
  eids text[];
BEGIN
  SELECT array_agg(workspace_id), array_agg(id) INTO wids, eids
  FROM (
    SELECT DISTINCT n.workspace_id, n.id
    FROM new_mail n
    JOIN old_mail o ON o.id = n.id
    WHERE NOT n.simulated AND (o.status = 'suppressed') <> (n.status = 'suppressed')
  ) s;
  IF wids IS NOT NULL THEN
    PERFORM hosted_refresh_health_batch(wids, eids);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS hosted_health_feedback ON sending_email_events;
CREATE TRIGGER hosted_health_feedback AFTER INSERT ON sending_email_events
  REFERENCING NEW TABLE AS new_events FOR EACH STATEMENT EXECUTE FUNCTION hosted_health_event();

DROP TRIGGER IF EXISTS hosted_health_suppressed ON sending_emails;
CREATE TRIGGER hosted_health_suppressed AFTER UPDATE ON sending_emails
  REFERENCING OLD TABLE AS old_mail NEW TABLE AS new_mail FOR EACH STATEMENT EXECUTE FUNCTION hosted_health_suppression();
