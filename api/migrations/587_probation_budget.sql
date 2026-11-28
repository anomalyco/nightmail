-- The shared Hosted installation, across every sender region. Keep a trailing
-- window's two boundary hours in full; a partial oldest hour is never estimated.
CREATE TABLE probation_budget_hours (
  hour timestamptz PRIMARY KEY,
  recipients bigint NOT NULL DEFAULT 0 CHECK (recipients >= 0),
  half_alert boolean NOT NULL DEFAULT false,
  -- Usage at or below both ceilings could admit the envelope that first had to wait.
  wait_hour_ceiling integer,
  wait_day_ceiling integer
);

-- Private dispatch metadata. Public email events expose their JSON data;
-- these columns are intentionally separate and NULL for unmetered attempts.
ALTER TABLE sending_email_events ADD COLUMN probation_hour timestamptz, ADD COLUMN probation_cost integer,
  ADD COLUMN probation_refund_owed boolean NOT NULL DEFAULT false;

-- Only eligible, version-fenced, locked emails with outside recipients reach
-- this function. One lock order across hours, including claims straddling UTC
-- rollover. VOLATILE reads a fresh snapshot after the preceding claimant commits.
CREATE FUNCTION probation_claim(batch jsonb, hourly integer, daily integer)
RETURNS TABLE (id text, reason text, charged_hour timestamptz, outside_cost integer, card jsonb)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  h timestamptz;
  hourly_used bigint; daily_used bigint; added integer := 0;
  half boolean; hit_half boolean; wait_hour integer; wait_day integer;
  hour_cap integer; day_cap integer; direct_full boolean := false; bulk_full boolean := false;
  r record; result jsonb := '[]'; alert jsonb := '{}';
BEGIN
  IF batch IS NULL THEN RETURN; END IF;
  -- The transaction's one installation lock also serializes adjacent UTC hours.
  -- Sample the hour after acquiring it. Refunds only decrease usage; the upsert
  -- adds to the current row rather than overwriting a concurrent refund.
  PERFORM pg_advisory_xact_lock(hashtextextended('nightmail:probation-budget',0));
  h := date_trunc('hour',clock_timestamp(),'UTC');
  SELECT coalesce(sum(b.recipients) FILTER (WHERE b.hour>=h-interval '1 hour'),0), coalesce(sum(b.recipients),0)
    INTO hourly_used,daily_used FROM probation_budget_hours b WHERE b.hour BETWEEN h-interval '24 hours' AND h;
  SELECT b.half_alert,b.wait_hour_ceiling,b.wait_day_ceiling INTO half,wait_hour,wait_day
    FROM probation_budget_hours b WHERE b.hour BETWEEN h-interval '24 hours' AND h ORDER BY b.hour DESC LIMIT 1;
  half := coalesce(half,false) AND (hourly_used*2>=hourly OR daily_used*2>=daily);
  IF hourly_used<=wait_hour AND daily_used<=wait_day THEN
    wait_hour := NULL; wait_day := NULL;
  END IF;

  FOR r IN SELECT * FROM jsonb_to_recordset(batch) AS x(id text,wid text,domain text,n int,cost int,direct boolean)
  LOOP
    reason := NULL;
    hour_cap := CASE WHEN r.direct THEN hourly ELSE floor(hourly*0.9) END;
    day_cap := CASE WHEN r.direct THEN daily ELSE floor(daily*0.9) END;
    IF (r.direct AND direct_full) OR (NOT r.direct AND bulk_full) OR hourly_used+added+r.cost > hour_cap OR daily_used+added+r.cost > day_cap THEN
      IF r.direct THEN direct_full := true; ELSE bulk_full := true; END IF;
      reason := 'PROBATION_BUDGET_WAIT';
      IF wait_hour IS NULL THEN
        wait_hour := hour_cap-r.cost; wait_day := day_cap-r.cost;
        alert := jsonb_build_object('waiting',true);
      END IF;
    ELSIF NOT hosted_burst_ok(r.wid,r.domain,r.n,r.direct) THEN
      reason := 'HOSTED_BURST_LIMIT';
    ELSE
      added := added+r.cost;
    END IF;
    result := result || jsonb_build_object('id',r.id,'reason',reason,'cost',r.cost);
  END LOOP;
  hourly_used := hourly_used+added; daily_used := daily_used+added;
  hit_half := hourly_used*2>=hourly OR daily_used*2>=daily;
  IF hit_half AND NOT half THEN
    alert := alert || jsonb_build_object('hour',hourly_used,'day',daily_used);
  END IF;
  INSERT INTO probation_budget_hours AS b(hour,recipients,half_alert,wait_hour_ceiling,wait_day_ceiling)
    VALUES(h,added,hit_half,wait_hour,wait_day)
    ON CONFLICT(hour) DO UPDATE SET recipients=b.recipients+excluded.recipients,
      half_alert=excluded.half_alert,wait_hour_ceiling=excluded.wait_hour_ceiling,wait_day_ceiling=excluded.wait_day_ceiling;
  RETURN QUERY SELECT x.id,x.reason,CASE WHEN x.reason IS NULL THEN h END,x.cost,alert
    FROM jsonb_to_recordset(result) x(id text,reason text,cost integer);
END $$;

-- The unique result insert marks only its existing attempt, never a bucket.
-- This also works for a dispatcher of the previous release during rollout.
CREATE FUNCTION probation_note_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE sending_email_events SET probation_refund_owed=true
    WHERE workspace_id=NEW.workspace_id AND external_id='attempt-start:'||substr(NEW.external_id,length('attempt-result:')+1)
      AND probation_hour IS NOT NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER note_probation_refund AFTER INSERT ON sending_email_events FOR EACH ROW
  WHEN (NEW.external_id LIKE 'attempt-result:%' AND NEW.type IN ('reject','provider_throttled','dispatch_deferred'))
  EXECUTE FUNCTION probation_note_refund();
