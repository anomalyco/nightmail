-- Non-blocking, idempotent, single-snapshot backfill of the real-Hosted standing columns and topic_arn added to
-- sending_metrics_hourly in migration 409. Computes (exact live - existing stored) across all 20 columns and topic_arn
-- in one statement: concurrent writes committed before the snapshot are in both sides (excluded); concurrent writes
-- committed after are in neither side and add their own trigger deltas. Re-running inserts 0 rows.

WITH live AS (
  SELECT e.workspace_id, e.region, coalesce(e.snapshot->>'kind', '') AS kind,
    date_trunc('hour', e.created_at, 'UTC') AS hour, coalesce(e.feedback_topic_arn, '') AS topic_arn,
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
    SELECT e.workspace_id, e.region, e.snapshot, e.created_at, e.feedback_topic_arn, e.simulated,
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
  ) e
  GROUP BY 1, 2, 3, 4, 5
)
INSERT INTO sending_metrics_hourly (
  workspace_id, region, kind, hour, topic_arn,
  emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated,
  real_emails, real_accepted, real_delivered, real_bounced, real_first_sends, real_first_bounced,
  real_complained, real_suppressed, real_marketing_delivered, real_marketing_clicked
)
SELECT workspace_id, region, kind, hour, topic_arn,
  sum(emails)::bigint, sum(accepted)::bigint, sum(delivered)::bigint, sum(bounced)::bigint, sum(complained)::bigint,
  sum(opened)::bigint, sum(clicked)::bigint, sum(failed)::bigint, sum(delivery_delayed)::bigint, sum(simulated)::bigint,
  sum(real_emails)::bigint, sum(real_accepted)::bigint, sum(real_delivered)::bigint, sum(real_bounced)::bigint,
  sum(real_first_sends)::bigint, sum(real_first_bounced)::bigint, sum(real_complained)::bigint, sum(real_suppressed)::bigint,
  sum(real_marketing_delivered)::bigint, sum(real_marketing_clicked)::bigint
FROM (
  SELECT * FROM live
  UNION ALL
  SELECT workspace_id, region, kind, hour, topic_arn,
    -emails, -accepted, -delivered, -bounced, -complained, -opened, -clicked, -failed, -delivery_delayed, -simulated,
    -real_emails, -real_accepted, -real_delivered, -real_bounced, -real_first_sends, -real_first_bounced,
    -real_complained, -real_suppressed, -real_marketing_delivered, -real_marketing_clicked
  FROM sending_metrics_hourly
) difference
GROUP BY 1, 2, 3, 4, 5
HAVING sum(emails) <> 0 OR sum(accepted) <> 0 OR sum(delivered) <> 0 OR sum(bounced) <> 0
    OR sum(complained) <> 0 OR sum(opened) <> 0 OR sum(clicked) <> 0 OR sum(failed) <> 0
    OR sum(delivery_delayed) <> 0 OR sum(simulated) <> 0
    OR sum(real_emails) <> 0 OR sum(real_accepted) <> 0 OR sum(real_delivered) <> 0 OR sum(real_bounced) <> 0
    OR sum(real_first_sends) <> 0 OR sum(real_first_bounced) <> 0 OR sum(real_complained) <> 0 OR sum(real_suppressed) <> 0
    OR sum(real_marketing_delivered) <> 0 OR sum(real_marketing_clicked) <> 0;
