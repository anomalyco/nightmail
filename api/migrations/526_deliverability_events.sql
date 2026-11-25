-- The event half of deliverability_hourly (migration 525): an email's first soft bounce (non_permanent_bounce), first
-- delivery delay (delivery_delay) and first open that SES did not flag as a bot or a privacy proxy (isBotEvent neither
-- true nor Likely: Apple Mail Privacy Protection and link scanners are flagged), each counted once, in the hour its
-- email was created. event_outcomes has one bit for both temporary failures and none for a human open, so these come
-- from the events: an email's event is its first of a class when every such event of the email is in this statement.
-- Two statements inserting an email's first event of a class at the same moment can both count it; the board's figures
-- are rates over thousands, and that race needs two of one email's events in concurrent batches.
--
-- Live deploy lock: SHARE ROW EXCLUSIVE on sending_email_events only, in its own transaction (as 408).
-- Emergency undo: ALTER TABLE sending_email_events DISABLE TRIGGER deliverability_events_insert;
DO $$
BEGIN
  FOR attempt IN 1..60 LOOP
    BEGIN
      SET LOCAL lock_timeout = '2s';
      LOCK TABLE sending_email_events IN SHARE ROW EXCLUSIVE MODE;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(1);
    END;
  END LOOP;
  RAISE EXCEPTION 'sending_email_events was busy for 3 minutes. Nothing was changed: run the migration again.' USING ERRCODE = 'lock_not_available';
END $$;

CREATE FUNCTION deliverability_event_class(type text, data jsonb) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE type WHEN 'non_permanent_bounce' THEN 'soft' WHEN 'delivery_delay' THEN 'deferred'
    WHEN 'open' THEN CASE WHEN coalesce(data->>'isBotEvent', 'Unknown') NOT IN ('true', 'Likely') THEN 'human' END END
$$;

CREATE FUNCTION deliverability_events_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH classed AS MATERIALIZED (
    SELECT n.workspace_id, n.email_id, deliverability_event_class(n.type, n.data) AS class, count(*) AS n
    FROM new_events n WHERE NOT n.simulated AND n.type IN ('non_permanent_bounce', 'delivery_delay', 'open')
    GROUP BY 1, 2, 3
  ), fresh AS (
    SELECT c.* FROM classed c
    WHERE c.class IS NOT NULL AND c.n = (SELECT count(*) FROM sending_email_events o
      WHERE o.workspace_id = c.workspace_id AND o.email_id = c.email_id AND o.type IN ('non_permanent_bounce', 'delivery_delay', 'open')
        AND deliverability_event_class(o.type, o.data) = c.class)
  )
  INSERT INTO deliverability_hourly (hour, region, kind, provider, soft_bounced, deferred, human_opened)
  SELECT date_trunc('hour', e.created_at, 'UTC'), e.region, coalesce(e.snapshot->>'kind', ''), mail_provider(lower(split_part(e.to_addresses->>0, '@', 2))),
    count(*) FILTER (WHERE f.class = 'soft'), count(*) FILTER (WHERE f.class = 'deferred'), count(*) FILTER (WHERE f.class = 'human')
  FROM fresh f JOIN sending_emails e ON e.id = f.email_id AND e.workspace_id = f.workspace_id
  WHERE NOT e.simulated
  GROUP BY 1, 2, 3, 4;
  RETURN NULL;
END $$;

CREATE TRIGGER deliverability_events_insert AFTER INSERT ON sending_email_events REFERENCING NEW TABLE AS new_events
  FOR EACH STATEMENT EXECUTE FUNCTION deliverability_events_insert();
