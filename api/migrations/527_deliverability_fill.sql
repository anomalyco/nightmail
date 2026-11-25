-- The backfill of deliverability_hourly (migrations 525, 526) from the retained mail (30 days), one page at a time
-- (migration 528 runs it): each page is six hours of emails by creation time, read per workspace through
-- sending_emails_created_page, with their events through sending_events_page (only for emails whose bits say they were
-- opened or temporarily refused: the only ones that can have such an event). A page inserts (exact - stored) for its
-- hours. Both triggers are committed, so concurrent writes add their own deltas and nothing is counted twice (as 505);
-- a page run again inserts nothing. Returns the next page's start, or null once a page starts after now.
CREATE FUNCTION deliverability_fill_page(after text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  a timestamptz := CASE WHEN coalesce(after, '') = '' THEN date_trunc('hour', now() - interval '30 days', 'UTC') ELSE after::timestamptz END;
  b timestamptz := a + interval '6 hours';
BEGIN
  IF a > now() THEN RETURN NULL; END IF;
  WITH mail AS MATERIALIZED (
    SELECT e.id, e.workspace_id, date_trunc('hour', e.created_at, 'UTC') AS hour, e.region, coalesce(e.snapshot->>'kind', '') AS kind,
      mail_provider(lower(split_part(e.to_addresses->>0, '@', 2))) AS provider,
      (NOT e.simulated AND e.status <> 'suppressed' AND (e.provider_id IS NOT NULL OR e.status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (e.event_outcomes & 1) <> 0))::int AS acc,
      (e.status = 'delivered' OR (e.event_outcomes & 2) <> 0)::int AS del,
      (e.status = 'bounced' OR (e.event_outcomes & 4) <> 0)::int AS hard,
      (e.status = 'complained' OR (e.event_outcomes & 8) <> 0)::int AS cmp,
      ((e.event_outcomes & 16) <> 0)::int AS opn,
      ((e.event_outcomes & 32) <> 0)::int AS clk,
      (e.event_outcomes & 144) <> 0 AS probe
    FROM workspaces w CROSS JOIN LATERAL (SELECT * FROM sending_emails e WHERE e.workspace_id = w.id AND e.created_at >= a AND e.created_at < b) e
    WHERE NOT e.simulated
  ), classes AS (
    SELECT m.hour, m.region, m.kind, m.provider, c.class FROM mail m CROSS JOIN LATERAL (
      SELECT DISTINCT deliverability_event_class(v.type, v.data) AS class FROM sending_email_events v
      WHERE v.workspace_id = m.workspace_id AND v.email_id = m.id AND v.type IN ('non_permanent_bounce', 'delivery_delay', 'open') AND NOT v.simulated
    ) c
    WHERE m.probe AND c.class IS NOT NULL
  )
  INSERT INTO deliverability_hourly (hour, region, kind, provider, accepted, delivered, hard_bounced, soft_bounced, deferred, complained, opened, human_opened, clicked)
  SELECT hour, region, kind, provider, sum(acc), sum(del), sum(hard), sum(soft), sum(dfr), sum(cmp), sum(opn), sum(hum), sum(clk)
  FROM (
    SELECT hour, region, kind, provider, acc::bigint, del::bigint, hard::bigint, 0::bigint AS soft, 0::bigint AS dfr, cmp::bigint, opn::bigint, 0::bigint AS hum, clk::bigint FROM mail
    UNION ALL SELECT hour, region, kind, provider, 0, 0, 0, (class = 'soft')::int, (class = 'deferred')::int, 0, 0, (class = 'human')::int, 0 FROM classes
    UNION ALL SELECT d.hour, d.region, d.kind, d.provider, -d.accepted, -d.delivered, -d.hard_bounced, -d.soft_bounced, -d.deferred,
      -d.complained, -d.opened, -d.human_opened, -d.clicked
    FROM deliverability_hourly d WHERE d.hour >= a AND d.hour < b
  ) x(hour, region, kind, provider, acc, del, hard, soft, dfr, cmp, opn, hum, clk)
  GROUP BY 1, 2, 3, 4
  HAVING sum(acc) <> 0 OR sum(del) <> 0 OR sum(hard) <> 0 OR sum(soft) <> 0 OR sum(dfr) <> 0
    OR sum(cmp) <> 0 OR sum(opn) <> 0 OR sum(hum) <> 0 OR sum(clk) <> 0;
  RETURN b::text;
END $$;
