-- Platform-wide deliverability by mailbox provider (Glass's Deliverability board, src/glass-deliverability.ts): every
-- real (not simulated) email's outcome, by the hour it was created, its region, its kind and its recipient's mailbox
-- provider. The same insert-only delta pattern as sending_metrics_hourly (migration 407): statement triggers append
-- delta rows, never touching a shared row, and the minute upkeep folds each key's rows into one
-- (fold_deliverability_hourly, src/sending-tallies.ts). Platform rows only (no workspace): at most a few rows an hour,
-- so the board sums 60 days of them on its read.
--
-- Unlike the per-workspace rollups this one is history: deleting mail (retention, a deleted workspace) subtracts
-- nothing, so the 30-day board can compare with the 30 days before. The daily recount prunes rows older than 120 days.
--
-- Columns from sending_emails (this migration): accepted, delivered, hard_bounced, complained, opened, clicked, from
-- the same status and event_outcomes bits as sending_metrics_hourly. Columns from sending_email_events (migration 526):
-- soft_bounced, deferred and human_opened, each an email's first such event.
--
-- mail_provider is deliverability.ts providerOf in SQL (the acceptance test keeps them equal).
--
-- Live deploy lock: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on sending_emails only (one table per transaction, as
-- 407), asked for in 2-second attempts and held until COMMIT.
-- Emergency undo: ALTER TABLE sending_emails DISABLE TRIGGER deliverability_mail_insert, DISABLE TRIGGER deliverability_mail_update;
DO $$
BEGIN
  FOR attempt IN 1..60 LOOP
    BEGIN
      SET LOCAL lock_timeout = '2s';
      LOCK TABLE sending_emails IN SHARE ROW EXCLUSIVE MODE;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(1);
    END;
  END LOOP;
  RAISE EXCEPTION 'sending_emails was busy for 3 minutes. Nothing was changed: run the migration again.' USING ERRCODE = 'lock_not_available';
END $$;

CREATE FUNCTION mail_provider(domain text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN domain IN ('gmail.com','googlemail.com') THEN 'gmail'
    WHEN domain IN ('msn.com') OR domain ~ '^(?:outlook|hotmail|live)\.[a-z]{2,}(?:\.[a-z]{2,})?$' THEN 'microsoft'
    WHEN domain IN ('ymail.com','rocketmail.com','aol.com') OR domain ~ '^(?:yahoo)\.[a-z]{2,}(?:\.[a-z]{2,})?$' THEN 'yahoo'
    WHEN domain IN ('icloud.com','me.com','mac.com') THEN 'apple'
    WHEN domain IN ('proton.me','protonmail.com') THEN 'proton'
    WHEN domain IN ('web.de') OR domain ~ '^(?:gmx)\.[a-z]{2,}(?:\.[a-z]{2,})?$' THEN 'gmx'
    ELSE 'other' END
$$;

CREATE TABLE deliverability_hourly (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hour timestamptz NOT NULL,
  region text NOT NULL,
  kind text NOT NULL,
  provider text NOT NULL,
  accepted bigint NOT NULL DEFAULT 0,
  delivered bigint NOT NULL DEFAULT 0,
  hard_bounced bigint NOT NULL DEFAULT 0,
  soft_bounced bigint NOT NULL DEFAULT 0,
  deferred bigint NOT NULL DEFAULT 0,
  complained bigint NOT NULL DEFAULT 0,
  opened bigint NOT NULL DEFAULT 0,
  human_opened bigint NOT NULL DEFAULT 0,
  clicked bigint NOT NULL DEFAULT 0
);
CREATE INDEX deliverability_hourly_hour ON deliverability_hourly (hour, region, kind, provider);

CREATE FUNCTION deliverability_mail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO deliverability_hourly (hour, region, kind, provider, accepted, delivered, hard_bounced, complained, opened, clicked)
  SELECT hour, region, kind, provider, sum(d_acc), sum(d_del), sum(d_hard), sum(d_cmp), sum(d_opn), sum(d_clk)
  FROM (
    SELECT date_trunc('hour', created_at, 'UTC') AS hour, region, coalesce(snapshot->>'kind', '') AS kind, mail_provider(lower(split_part(to_addresses->>0, '@', 2))) AS provider,
        (NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0))::int::bigint AS d_acc,
        (status = 'delivered' OR (event_outcomes & 2) <> 0)::int::bigint AS d_del,
        (status = 'bounced' OR (event_outcomes & 4) <> 0)::int::bigint AS d_hard,
        (status = 'complained' OR (event_outcomes & 8) <> 0)::int::bigint AS d_cmp,
        ((event_outcomes & 16) <> 0)::int::bigint AS d_opn,
        ((event_outcomes & 32) <> 0)::int::bigint AS d_clk
    FROM new_mail WHERE NOT simulated
  ) s
  GROUP BY 1, 2, 3, 4
  HAVING sum(d_acc) <> 0 OR sum(d_del) <> 0 OR sum(d_hard) <> 0 OR sum(d_cmp) <> 0 OR sum(d_opn) <> 0 OR sum(d_clk) <> 0;
  RETURN NULL;
END $$;

CREATE FUNCTION deliverability_mail_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO deliverability_hourly (hour, region, kind, provider, accepted, delivered, hard_bounced, complained, opened, clicked)
  SELECT hour, region, kind, provider, sum(d_acc), sum(d_del), sum(d_hard), sum(d_cmp), sum(d_opn), sum(d_clk)
  FROM (
    SELECT date_trunc('hour', created_at, 'UTC') AS hour, region, coalesce(snapshot->>'kind', '') AS kind, mail_provider(lower(split_part(to_addresses->>0, '@', 2))) AS provider,
        (NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0))::int::bigint AS d_acc,
        (status = 'delivered' OR (event_outcomes & 2) <> 0)::int::bigint AS d_del,
        (status = 'bounced' OR (event_outcomes & 4) <> 0)::int::bigint AS d_hard,
        (status = 'complained' OR (event_outcomes & 8) <> 0)::int::bigint AS d_cmp,
        ((event_outcomes & 16) <> 0)::int::bigint AS d_opn,
        ((event_outcomes & 32) <> 0)::int::bigint AS d_clk
    FROM new_mail WHERE NOT simulated
    UNION ALL
    SELECT date_trunc('hour', created_at, 'UTC'), region, coalesce(snapshot->>'kind', ''), mail_provider(lower(split_part(to_addresses->>0, '@', 2))),
        -(NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0))::int::bigint,
        -(status = 'delivered' OR (event_outcomes & 2) <> 0)::int::bigint,
        -(status = 'bounced' OR (event_outcomes & 4) <> 0)::int::bigint,
        -(status = 'complained' OR (event_outcomes & 8) <> 0)::int::bigint,
        -((event_outcomes & 16) <> 0)::int::bigint,
        -((event_outcomes & 32) <> 0)::int::bigint
    FROM old_mail WHERE NOT simulated
  ) s
  GROUP BY 1, 2, 3, 4
  HAVING sum(d_acc) <> 0 OR sum(d_del) <> 0 OR sum(d_hard) <> 0 OR sum(d_cmp) <> 0 OR sum(d_opn) <> 0 OR sum(d_clk) <> 0;
  RETURN NULL;
END $$;

CREATE TRIGGER deliverability_mail_insert AFTER INSERT ON sending_emails REFERENCING NEW TABLE AS new_mail
  FOR EACH STATEMENT EXECUTE FUNCTION deliverability_mail_insert();
CREATE TRIGGER deliverability_mail_update AFTER UPDATE ON sending_emails REFERENCING OLD TABLE AS old_mail NEW TABLE AS new_mail
  FOR EACH STATEMENT EXECUTE FUNCTION deliverability_mail_update();

-- One row per key, in bounded batches under a try-lock: never blocks a writer (as fold_sending_metrics_ten_minute).
CREATE FUNCTION fold_deliverability_hourly(batch_limit integer DEFAULT 50000)
RETURNS TABLE (removed_rows integer, kept_rows integer, unfolded_rows bigint) LANGUAGE plpgsql AS $$
DECLARE
  removed integer := 0;
  kept integer := 0;
  extra bigint := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(275817, 6) THEN
    RETURN QUERY SELECT 0, 0, 0::bigint;
    RETURN;
  END IF;
  WITH multi AS (
    SELECT hour, region, kind, provider FROM deliverability_hourly GROUP BY 1, 2, 3, 4
    HAVING count(*) > 1 OR bool_or(accepted = 0 AND delivered = 0 AND hard_bounced = 0 AND soft_bounced = 0 AND deferred = 0
      AND complained = 0 AND opened = 0 AND human_opened = 0 AND clicked = 0)
  ), picked AS (
    SELECT d.id FROM deliverability_hourly d JOIN multi m USING (hour, region, kind, provider) ORDER BY d.id LIMIT batch_limit
  ), gone AS (
    DELETE FROM deliverability_hourly d USING picked p WHERE d.id = p.id
    RETURNING d.hour, d.region, d.kind, d.provider, d.accepted, d.delivered, d.hard_bounced, d.soft_bounced, d.deferred,
      d.complained, d.opened, d.human_opened, d.clicked
  ), folded AS (
    INSERT INTO deliverability_hourly (hour, region, kind, provider, accepted, delivered, hard_bounced, soft_bounced, deferred, complained, opened, human_opened, clicked)
    SELECT hour, region, kind, provider, sum(accepted), sum(delivered), sum(hard_bounced), sum(soft_bounced), sum(deferred),
      sum(complained), sum(opened), sum(human_opened), sum(clicked)
    FROM gone GROUP BY 1, 2, 3, 4
    HAVING sum(accepted) <> 0 OR sum(delivered) <> 0 OR sum(hard_bounced) <> 0 OR sum(soft_bounced) <> 0 OR sum(deferred) <> 0
      OR sum(complained) <> 0 OR sum(opened) <> 0 OR sum(human_opened) <> 0 OR sum(clicked) <> 0
    RETURNING 1
  )
  SELECT (SELECT count(*)::int FROM gone), (SELECT count(*)::int FROM folded) INTO removed, kept;
  SELECT coalesce(sum(cnt - 1), 0)::bigint INTO extra FROM (SELECT count(*) AS cnt FROM deliverability_hourly GROUP BY hour, region, kind, provider HAVING count(*) > 1) s;
  RETURN QUERY SELECT removed, kept, extra;
END $$;
