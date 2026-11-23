-- Extends sending_metrics_hourly (migration 407) with real-Hosted standing counts and feedback topic_arn, computed in
-- the SAME single-pass sending_emails statement trigger functions (no second trigger stacked on sending_emails, and no
-- third delta table). standing.refreshEvidence now reads ~8-30 hourly rows per workspace (< 1 ms, zero sort spill)
-- instead of scanning 7-30 days of sending_emails and calling hosted_real_cost() per row (9.1 s + 168 MB spill at 1.8M).
--
-- Live deploy safety:
-- - ALTER TABLE sending_metrics_hourly ADD COLUMN ... NOT NULL DEFAULT <constant> is metadata-only in PG 11+ (no table
--   rewrite, sub-millisecond lock on the tiny tally table; 2 s lock_timeout).
-- - CREATE OR REPLACE FUNCTION updates the existing sending_tally_* trigger bodies with no table lock on sending_emails.
-- - Migration 410 backfills the new columns in a separate transaction using a single-snapshot diff with no write locks.
--
-- Emergency undo (same single statement as migration 407; refreshEvidence checks talliesEnabled and falls back cleanly
-- under its 15 s statement_timeout):
--   ALTER TABLE sending_emails DISABLE TRIGGER sending_tally_insert, DISABLE TRIGGER sending_tally_update, DISABLE TRIGGER sending_tally_delete;

SET LOCAL lock_timeout = '2s';

ALTER TABLE sending_metrics_hourly
  ADD COLUMN topic_arn text NOT NULL DEFAULT '',
  ADD COLUMN real_emails bigint NOT NULL DEFAULT 0,
  ADD COLUMN real_accepted bigint NOT NULL DEFAULT 0,
  ADD COLUMN real_delivered bigint NOT NULL DEFAULT 0,
  ADD COLUMN real_bounced bigint NOT NULL DEFAULT 0,
  ADD COLUMN real_first_sends bigint NOT NULL DEFAULT 0,
  ADD COLUMN real_first_bounced bigint NOT NULL DEFAULT 0,
  ADD COLUMN real_complained bigint NOT NULL DEFAULT 0,
  ADD COLUMN real_suppressed bigint NOT NULL DEFAULT 0,
  ADD COLUMN real_marketing_delivered bigint NOT NULL DEFAULT 0,
  ADD COLUMN real_marketing_clicked bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION sending_tally_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
    workspace_id, region, kind, hour, topic_arn,
    emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated,
    real_emails, real_accepted, real_delivered, real_bounced, real_first_sends, real_first_bounced,
    real_complained, real_suppressed, real_marketing_delivered, real_marketing_clicked
  )
  SELECT
    workspace_id, region, coalesce(snapshot->>'kind', ''), date_trunc('hour', created_at, 'UTC'), coalesce(feedback_topic_arn, ''),
    count(*),
    count(*) FILTER (WHERE is_acc),
    count(*) FILTER (WHERE is_del),
    count(*) FILTER (WHERE is_bnc),
    count(*) FILTER (WHERE is_cmp),
    count(*) FILTER (WHERE is_opn),
    count(*) FILTER (WHERE is_clk),
    count(*) FILTER (WHERE is_fld),
    count(*) FILTER (WHERE is_dly),
    count(*) FILTER (WHERE simulated),
    count(*) FILTER (WHERE is_real),
    count(*) FILTER (WHERE is_real AND is_acc),
    count(*) FILTER (WHERE is_real AND is_del),
    count(*) FILTER (WHERE is_real AND is_bnc),
    count(*) FILTER (WHERE is_real AND is_acc AND is_first),
    count(*) FILTER (WHERE is_real AND is_bnc AND is_first),
    count(*) FILTER (WHERE is_real AND is_cmp),
    count(*) FILTER (WHERE is_real AND is_sup AND is_first),
    count(*) FILTER (WHERE is_real AND is_del AND is_mkt),
    count(*) FILTER (WHERE is_real AND is_clk AND is_mkt)
  FROM (
    SELECT workspace_id, region, snapshot, created_at, feedback_topic_arn, simulated,
      (NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0)) AS is_acc,
      (status = 'delivered' OR (event_outcomes & 2) <> 0) AS is_del,
      (status = 'bounced' OR (event_outcomes & 4) <> 0) AS is_bnc,
      (status = 'complained' OR (event_outcomes & 8) <> 0) AS is_cmp,
      ((event_outcomes & 16) <> 0) AS is_opn,
      ((event_outcomes & 32) <> 0) AS is_clk,
      (status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0) AS is_fld,
      (status = 'delayed' OR (event_outcomes & 128) <> 0) AS is_dly,
      (NOT simulated AND CASE WHEN jsonb_array_length(to_addresses) = 1 AND cc_addresses = '[]'::jsonb AND bcc_addresses = '[]'::jsonb THEN lower(to_addresses->>0) NOT LIKE '%@simulator.amazonses.com' ELSE hosted_real_cost(to_addresses || cc_addresses || bcc_addresses) > 0 END) AS is_real,
      (campaign_id IS NOT NULL) AS is_first,
      (status = 'suppressed') AS is_sup,
      coalesce(snapshot->>'kind' = 'marketing' OR campaign_id IS NOT NULL OR snapshot ? 'bulk', false) AS is_mkt
    FROM new_mail
  ) s
  GROUP BY 1, 2, 3, 4, 5;

  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION sending_tally_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM new_mail WHERE campaign_id IS NOT NULL UNION ALL SELECT 1 FROM old_mail WHERE campaign_id IS NOT NULL) THEN
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
  END IF;

  IF EXISTS (
    SELECT 1 FROM new_mail n JOIN old_mail o ON o.id = n.id
    WHERE (n.status IS DISTINCT FROM o.status AND (
            n.status IN ('accepted','sent','delivered','bounced','complained','delayed','rejected','rendering_failed','suppressed')
            OR o.status IN ('accepted','sent','delivered','bounced','complained','delayed','rejected','rendering_failed','suppressed')))
       OR (n.provider_id IS NULL) IS DISTINCT FROM (o.provider_id IS NULL)
       OR n.event_outcomes IS DISTINCT FROM o.event_outcomes
       OR n.simulated IS DISTINCT FROM o.simulated
       OR n.region IS DISTINCT FROM o.region
       OR n.feedback_topic_arn IS DISTINCT FROM o.feedback_topic_arn
       OR date_trunc('hour', n.created_at, 'UTC') IS DISTINCT FROM date_trunc('hour', o.created_at, 'UTC')
       OR (n.snapshot->>'kind') IS DISTINCT FROM (o.snapshot->>'kind')
       OR (n.snapshot ? 'bulk') IS DISTINCT FROM (o.snapshot ? 'bulk')
       OR (n.campaign_id IS NOT NULL) IS DISTINCT FROM (o.campaign_id IS NOT NULL)
  ) THEN
  WITH rows AS (
    SELECT 1::bigint AS sign, workspace_id, region, coalesce(snapshot->>'kind', '') AS kind,
      date_trunc('hour', created_at, 'UTC') AS hour, coalesce(feedback_topic_arn, '') AS topic_arn, simulated,
      (NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0)) AS is_acc,
      (status = 'delivered' OR (event_outcomes & 2) <> 0) AS is_del,
      (status = 'bounced' OR (event_outcomes & 4) <> 0) AS is_bnc,
      (status = 'complained' OR (event_outcomes & 8) <> 0) AS is_cmp,
      ((event_outcomes & 16) <> 0) AS is_opn,
      ((event_outcomes & 32) <> 0) AS is_clk,
      (status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0) AS is_fld,
      (status = 'delayed' OR (event_outcomes & 128) <> 0) AS is_dly,
      (NOT simulated AND CASE WHEN jsonb_array_length(to_addresses) = 1 AND cc_addresses = '[]'::jsonb AND bcc_addresses = '[]'::jsonb THEN lower(to_addresses->>0) NOT LIKE '%@simulator.amazonses.com' ELSE hosted_real_cost(to_addresses || cc_addresses || bcc_addresses) > 0 END) AS is_real,
      (campaign_id IS NOT NULL) AS is_first,
      (status = 'suppressed') AS is_sup,
      coalesce(snapshot->>'kind' = 'marketing' OR campaign_id IS NOT NULL OR snapshot ? 'bulk', false) AS is_mkt
    FROM new_mail
    UNION ALL
    SELECT -1::bigint AS sign, workspace_id, region, coalesce(snapshot->>'kind', '') AS kind,
      date_trunc('hour', created_at, 'UTC') AS hour, coalesce(feedback_topic_arn, '') AS topic_arn, simulated,
      (NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0)) AS is_acc,
      (status = 'delivered' OR (event_outcomes & 2) <> 0) AS is_del,
      (status = 'bounced' OR (event_outcomes & 4) <> 0) AS is_bnc,
      (status = 'complained' OR (event_outcomes & 8) <> 0) AS is_cmp,
      ((event_outcomes & 16) <> 0) AS is_opn,
      ((event_outcomes & 32) <> 0) AS is_clk,
      (status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0) AS is_fld,
      (status = 'delayed' OR (event_outcomes & 128) <> 0) AS is_dly,
      (NOT simulated AND CASE WHEN jsonb_array_length(to_addresses) = 1 AND cc_addresses = '[]'::jsonb AND bcc_addresses = '[]'::jsonb THEN lower(to_addresses->>0) NOT LIKE '%@simulator.amazonses.com' ELSE hosted_real_cost(to_addresses || cc_addresses || bcc_addresses) > 0 END) AS is_real,
      (campaign_id IS NOT NULL) AS is_first,
      (status = 'suppressed') AS is_sup,
      coalesce(snapshot->>'kind' = 'marketing' OR campaign_id IS NOT NULL OR snapshot ? 'bulk', false) AS is_mkt
    FROM old_mail
  ), summed AS (
    SELECT workspace_id, region, kind, hour, topic_arn,
      sum(sign) AS emails,
      sum(CASE WHEN is_acc THEN sign ELSE 0 END) AS accepted,
      sum(CASE WHEN is_del THEN sign ELSE 0 END) AS delivered,
      sum(CASE WHEN is_bnc THEN sign ELSE 0 END) AS bounced,
      sum(CASE WHEN is_cmp THEN sign ELSE 0 END) AS complained,
      sum(CASE WHEN is_opn THEN sign ELSE 0 END) AS opened,
      sum(CASE WHEN is_clk THEN sign ELSE 0 END) AS clicked,
      sum(CASE WHEN is_fld THEN sign ELSE 0 END) AS failed,
      sum(CASE WHEN is_dly THEN sign ELSE 0 END) AS delivery_delayed,
      sum(CASE WHEN simulated THEN sign ELSE 0 END) AS simulated,
      sum(CASE WHEN is_real THEN sign ELSE 0 END) AS real_emails,
      sum(CASE WHEN is_real AND is_acc THEN sign ELSE 0 END) AS real_accepted,
      sum(CASE WHEN is_real AND is_del THEN sign ELSE 0 END) AS real_delivered,
      sum(CASE WHEN is_real AND is_bnc THEN sign ELSE 0 END) AS real_bounced,
      sum(CASE WHEN is_real AND is_acc AND is_first THEN sign ELSE 0 END) AS real_first_sends,
      sum(CASE WHEN is_real AND is_bnc AND is_first THEN sign ELSE 0 END) AS real_first_bounced,
      sum(CASE WHEN is_real AND is_cmp THEN sign ELSE 0 END) AS real_complained,
      sum(CASE WHEN is_real AND is_sup AND is_first THEN sign ELSE 0 END) AS real_suppressed,
      sum(CASE WHEN is_real AND is_del AND is_mkt THEN sign ELSE 0 END) AS real_marketing_delivered,
      sum(CASE WHEN is_real AND is_clk AND is_mkt THEN sign ELSE 0 END) AS real_marketing_clicked
    FROM rows
    GROUP BY 1, 2, 3, 4, 5
  )
  INSERT INTO sending_metrics_hourly (
    workspace_id, region, kind, hour, topic_arn,
    emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated,
    real_emails, real_accepted, real_delivered, real_bounced, real_first_sends, real_first_bounced,
    real_complained, real_suppressed, real_marketing_delivered, real_marketing_clicked
  )
  SELECT * FROM summed
  WHERE emails <> 0 OR accepted <> 0 OR delivered <> 0 OR bounced <> 0 OR complained <> 0
     OR opened <> 0 OR clicked <> 0 OR failed <> 0 OR delivery_delayed <> 0 OR simulated <> 0
     OR real_emails <> 0 OR real_accepted <> 0 OR real_delivered <> 0 OR real_bounced <> 0
     OR real_first_sends <> 0 OR real_first_bounced <> 0 OR real_complained <> 0 OR real_suppressed <> 0
     OR real_marketing_delivered <> 0 OR real_marketing_clicked <> 0;
  END IF;

  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION sending_tally_delete() RETURNS trigger LANGUAGE plpgsql AS $$
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
    workspace_id, region, kind, hour, topic_arn,
    emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated,
    real_emails, real_accepted, real_delivered, real_bounced, real_first_sends, real_first_bounced,
    real_complained, real_suppressed, real_marketing_delivered, real_marketing_clicked
  )
  SELECT
    workspace_id, region, coalesce(snapshot->>'kind', ''), date_trunc('hour', created_at, 'UTC'), coalesce(feedback_topic_arn, ''),
    -count(*),
    -count(*) FILTER (WHERE is_acc),
    -count(*) FILTER (WHERE is_del),
    -count(*) FILTER (WHERE is_bnc),
    -count(*) FILTER (WHERE is_cmp),
    -count(*) FILTER (WHERE is_opn),
    -count(*) FILTER (WHERE is_clk),
    -count(*) FILTER (WHERE is_fld),
    -count(*) FILTER (WHERE is_dly),
    -count(*) FILTER (WHERE simulated),
    -count(*) FILTER (WHERE is_real),
    -count(*) FILTER (WHERE is_real AND is_acc),
    -count(*) FILTER (WHERE is_real AND is_del),
    -count(*) FILTER (WHERE is_real AND is_bnc),
    -count(*) FILTER (WHERE is_real AND is_acc AND is_first),
    -count(*) FILTER (WHERE is_real AND is_bnc AND is_first),
    -count(*) FILTER (WHERE is_real AND is_cmp),
    -count(*) FILTER (WHERE is_real AND is_sup AND is_first),
    -count(*) FILTER (WHERE is_real AND is_del AND is_mkt),
    -count(*) FILTER (WHERE is_real AND is_clk AND is_mkt)
  FROM (
    SELECT workspace_id, region, snapshot, created_at, feedback_topic_arn, simulated,
      (NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0)) AS is_acc,
      (status = 'delivered' OR (event_outcomes & 2) <> 0) AS is_del,
      (status = 'bounced' OR (event_outcomes & 4) <> 0) AS is_bnc,
      (status = 'complained' OR (event_outcomes & 8) <> 0) AS is_cmp,
      ((event_outcomes & 16) <> 0) AS is_opn,
      ((event_outcomes & 32) <> 0) AS is_clk,
      (status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0) AS is_fld,
      (status = 'delayed' OR (event_outcomes & 128) <> 0) AS is_dly,
      (NOT simulated AND CASE WHEN jsonb_array_length(to_addresses) = 1 AND cc_addresses = '[]'::jsonb AND bcc_addresses = '[]'::jsonb THEN lower(to_addresses->>0) NOT LIKE '%@simulator.amazonses.com' ELSE hosted_real_cost(to_addresses || cc_addresses || bcc_addresses) > 0 END) AS is_real,
      (campaign_id IS NOT NULL) AS is_first,
      (status = 'suppressed') AS is_sup,
      coalesce(snapshot->>'kind' = 'marketing' OR campaign_id IS NOT NULL OR snapshot ? 'bulk', false) AS is_mkt
    FROM old_mail
  ) s
  GROUP BY 1, 2, 3, 4, 5;

  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION fold_sending_metrics_hourly(batch_limit integer DEFAULT 50000)
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
    SELECT workspace_id, region, kind, hour, topic_arn
    FROM sending_metrics_hourly
    GROUP BY 1, 2, 3, 4, 5
    HAVING count(*) > 1 OR bool_or(
      emails = 0 AND accepted = 0 AND delivered = 0 AND bounced = 0
      AND complained = 0 AND opened = 0 AND clicked = 0 AND failed = 0 AND delivery_delayed = 0 AND simulated = 0
      AND real_emails = 0 AND real_accepted = 0 AND real_delivered = 0 AND real_bounced = 0
      AND real_first_sends = 0 AND real_first_bounced = 0 AND real_complained = 0 AND real_suppressed = 0
      AND real_marketing_delivered = 0 AND real_marketing_clicked = 0
    )
  ), picked AS (
    SELECT t.id
    FROM sending_metrics_hourly t
    JOIN multi m
      ON m.workspace_id = t.workspace_id AND m.region = t.region
     AND m.kind = t.kind AND m.hour = t.hour AND m.topic_arn = t.topic_arn
    ORDER BY t.id
    LIMIT batch_limit
  ), gone AS (
    DELETE FROM sending_metrics_hourly t
    USING picked p
    WHERE t.id = p.id
    RETURNING t.workspace_id, t.region, t.kind, t.hour, t.topic_arn,
      t.emails, t.accepted, t.delivered, t.bounced, t.complained,
      t.opened, t.clicked, t.failed, t.delivery_delayed, t.simulated,
      t.real_emails, t.real_accepted, t.real_delivered, t.real_bounced, t.real_first_sends,
      t.real_first_bounced, t.real_complained, t.real_suppressed, t.real_marketing_delivered, t.real_marketing_clicked
  ), folded AS (
    INSERT INTO sending_metrics_hourly (
      workspace_id, region, kind, hour, topic_arn,
      emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated,
      real_emails, real_accepted, real_delivered, real_bounced, real_first_sends, real_first_bounced,
      real_complained, real_suppressed, real_marketing_delivered, real_marketing_clicked
    )
    SELECT workspace_id, region, kind, hour, topic_arn,
      sum(emails), sum(accepted), sum(delivered), sum(bounced), sum(complained),
      sum(opened), sum(clicked), sum(failed), sum(delivery_delayed), sum(simulated),
      sum(real_emails), sum(real_accepted), sum(real_delivered), sum(real_bounced), sum(real_first_sends),
      sum(real_first_bounced), sum(real_complained), sum(real_suppressed), sum(real_marketing_delivered), sum(real_marketing_clicked)
    FROM gone
    GROUP BY 1, 2, 3, 4, 5
    HAVING sum(emails) <> 0 OR sum(accepted) <> 0 OR sum(delivered) <> 0 OR sum(bounced) <> 0
        OR sum(complained) <> 0 OR sum(opened) <> 0 OR sum(clicked) <> 0 OR sum(failed) <> 0
        OR sum(delivery_delayed) <> 0 OR sum(simulated) <> 0
        OR sum(real_emails) <> 0 OR sum(real_accepted) <> 0 OR sum(real_delivered) <> 0 OR sum(real_bounced) <> 0
        OR sum(real_first_sends) <> 0 OR sum(real_first_bounced) <> 0 OR sum(real_complained) <> 0 OR sum(real_suppressed) <> 0
        OR sum(real_marketing_delivered) <> 0 OR sum(real_marketing_clicked) <> 0
    RETURNING 1
  )
  SELECT (SELECT count(*)::int FROM gone), (SELECT count(*)::int FROM folded) INTO removed, kept;

  SELECT coalesce(sum(cnt - 1), 0)::bigint INTO extra
  FROM (
    SELECT count(*) AS cnt
    FROM sending_metrics_hourly
    GROUP BY workspace_id, region, kind, hour, topic_arn
    HAVING count(*) > 1
  ) s;

  RETURN QUERY SELECT removed, kept, extra;
END $$;

DROP FUNCTION reconcile_sending_metrics_hourly(text);
CREATE FUNCTION reconcile_sending_metrics_hourly(wid text)
RETURNS TABLE (
  region text, kind text, hour timestamptz, topic_arn text,
  emails bigint, accepted bigint, delivered bigint, bounced bigint,
  complained bigint, opened bigint, clicked bigint, failed bigint, delivery_delayed bigint, simulated bigint,
  real_emails bigint, real_accepted bigint, real_delivered bigint, real_bounced bigint,
  real_first_sends bigint, real_first_bounced bigint, real_complained bigint, real_suppressed bigint,
  real_marketing_delivered bigint, real_marketing_clicked bigint
) LANGUAGE plpgsql SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(275819, hashtext(wid));
  RETURN QUERY
  WITH live AS (
    SELECT e.region, coalesce(e.snapshot->>'kind', '') AS kind, date_trunc('hour', e.created_at, 'UTC') AS hour,
      coalesce(e.feedback_topic_arn, '') AS topic_arn,
      count(*)::bigint AS emails,
      count(*) FILTER (WHERE is_acc)::bigint AS accepted,
      count(*) FILTER (WHERE is_del)::bigint AS delivered,
      count(*) FILTER (WHERE is_bnc)::bigint AS bounced,
      count(*) FILTER (WHERE is_cmp)::bigint AS complained,
      count(*) FILTER (WHERE is_opn)::bigint AS opened,
      count(*) FILTER (WHERE is_clk)::bigint AS clicked,
      count(*) FILTER (WHERE is_fld)::bigint AS failed,
      count(*) FILTER (WHERE is_dly)::bigint AS delivery_delayed,
      count(*) FILTER (WHERE e.simulated)::bigint AS simulated,
      count(*) FILTER (WHERE is_real)::bigint AS real_emails,
      count(*) FILTER (WHERE is_real AND is_acc)::bigint AS real_accepted,
      count(*) FILTER (WHERE is_real AND is_del)::bigint AS real_delivered,
      count(*) FILTER (WHERE is_real AND is_bnc)::bigint AS real_bounced,
      count(*) FILTER (WHERE is_real AND is_acc AND is_first)::bigint AS real_first_sends,
      count(*) FILTER (WHERE is_real AND is_bnc AND is_first)::bigint AS real_first_bounced,
      count(*) FILTER (WHERE is_real AND is_cmp)::bigint AS real_complained,
      count(*) FILTER (WHERE is_real AND is_sup AND is_first)::bigint AS real_suppressed,
      count(*) FILTER (WHERE is_real AND is_del AND is_mkt)::bigint AS real_marketing_delivered,
      count(*) FILTER (WHERE is_real AND is_clk AND is_mkt)::bigint AS real_marketing_clicked
    FROM (
      SELECT e.region, e.snapshot, e.created_at, e.feedback_topic_arn, e.simulated,
        (NOT e.simulated AND e.status <> 'suppressed' AND (e.provider_id IS NOT NULL OR e.status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (e.event_outcomes & 1) <> 0)) AS is_acc,
        (e.status = 'delivered' OR (e.event_outcomes & 2) <> 0) AS is_del,
        (e.status = 'bounced' OR (e.event_outcomes & 4) <> 0) AS is_bnc,
        (e.status = 'complained' OR (e.event_outcomes & 8) <> 0) AS is_cmp,
        ((e.event_outcomes & 16) <> 0) AS is_opn,
        ((e.event_outcomes & 32) <> 0) AS is_clk,
        (e.status IN ('rejected','rendering_failed') OR (e.event_outcomes & 64) <> 0) AS is_fld,
        (e.status = 'delayed' OR (e.event_outcomes & 128) <> 0) AS is_dly,
        (NOT e.simulated AND CASE WHEN jsonb_array_length(e.to_addresses) = 1 AND e.cc_addresses = '[]'::jsonb AND e.bcc_addresses = '[]'::jsonb THEN lower(e.to_addresses->>0) NOT LIKE '%@simulator.amazonses.com' ELSE hosted_real_cost(e.to_addresses || e.cc_addresses || e.bcc_addresses) > 0 END) AS is_real,
        (e.campaign_id IS NOT NULL) AS is_first,
        (e.status = 'suppressed') AS is_sup,
        coalesce(e.snapshot->>'kind' = 'marketing' OR e.campaign_id IS NOT NULL OR e.snapshot ? 'bulk', false) AS is_mkt
      FROM sending_emails e
      WHERE e.workspace_id = wid
    ) e
    GROUP BY 1, 2, 3, 4
  ), diff AS (
    SELECT s.region, s.kind, s.hour, s.topic_arn,
      sum(s.emails)::bigint AS emails, sum(s.accepted)::bigint AS accepted, sum(s.delivered)::bigint AS delivered,
      sum(s.bounced)::bigint AS bounced, sum(s.complained)::bigint AS complained, sum(s.opened)::bigint AS opened,
      sum(s.clicked)::bigint AS clicked, sum(s.failed)::bigint AS failed, sum(s.delivery_delayed)::bigint AS delivery_delayed,
      sum(s.simulated)::bigint AS simulated,
      sum(s.real_emails)::bigint AS real_emails, sum(s.real_accepted)::bigint AS real_accepted,
      sum(s.real_delivered)::bigint AS real_delivered, sum(s.real_bounced)::bigint AS real_bounced,
      sum(s.real_first_sends)::bigint AS real_first_sends, sum(s.real_first_bounced)::bigint AS real_first_bounced,
      sum(s.real_complained)::bigint AS real_complained, sum(s.real_suppressed)::bigint AS real_suppressed,
      sum(s.real_marketing_delivered)::bigint AS real_marketing_delivered, sum(s.real_marketing_clicked)::bigint AS real_marketing_clicked
    FROM (
      SELECT * FROM live
      UNION ALL
      SELECT t.region, t.kind, t.hour, t.topic_arn,
        -t.emails, -t.accepted, -t.delivered, -t.bounced, -t.complained,
        -t.opened, -t.clicked, -t.failed, -t.delivery_delayed, -t.simulated,
        -t.real_emails, -t.real_accepted, -t.real_delivered, -t.real_bounced,
        -t.real_first_sends, -t.real_first_bounced, -t.real_complained, -t.real_suppressed,
        -t.real_marketing_delivered, -t.real_marketing_clicked
      FROM sending_metrics_hourly t
      WHERE t.workspace_id = wid
    ) s
    GROUP BY 1, 2, 3, 4
    HAVING sum(s.emails) <> 0 OR sum(s.accepted) <> 0 OR sum(s.delivered) <> 0 OR sum(s.bounced) <> 0
        OR sum(s.complained) <> 0 OR sum(s.opened) <> 0 OR sum(s.clicked) <> 0 OR sum(s.failed) <> 0
        OR sum(s.delivery_delayed) <> 0 OR sum(s.simulated) <> 0
        OR sum(s.real_emails) <> 0 OR sum(s.real_accepted) <> 0 OR sum(s.real_delivered) <> 0 OR sum(s.real_bounced) <> 0
        OR sum(s.real_first_sends) <> 0 OR sum(s.real_first_bounced) <> 0 OR sum(s.real_complained) <> 0 OR sum(s.real_suppressed) <> 0
        OR sum(s.real_marketing_delivered) <> 0 OR sum(s.real_marketing_clicked) <> 0
  )
  INSERT INTO sending_metrics_hourly AS n (
    workspace_id, region, kind, hour, topic_arn,
    emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated,
    real_emails, real_accepted, real_delivered, real_bounced, real_first_sends, real_first_bounced,
    real_complained, real_suppressed, real_marketing_delivered, real_marketing_clicked
  )
  SELECT wid, d.region, d.kind, d.hour, d.topic_arn,
    d.emails, d.accepted, d.delivered, d.bounced, d.complained,
    d.opened, d.clicked, d.failed, d.delivery_delayed, d.simulated,
    d.real_emails, d.real_accepted, d.real_delivered, d.real_bounced, d.real_first_sends, d.real_first_bounced,
    d.real_complained, d.real_suppressed, d.real_marketing_delivered, d.real_marketing_clicked
  FROM diff d
  RETURNING n.region, n.kind, n.hour, n.topic_arn, n.emails, n.accepted, n.delivered, n.bounced,
    n.complained, n.opened, n.clicked, n.failed, n.delivery_delayed, n.simulated,
    n.real_emails, n.real_accepted, n.real_delivered, n.real_bounced, n.real_first_sends, n.real_first_bounced,
    n.real_complained, n.real_suppressed, n.real_marketing_delivered, n.real_marketing_clicked;
END $$;
