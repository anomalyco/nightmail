SET LOCAL lock_timeout='2s';
-- Single source of truth for per-unit billing rates in SQL: billing_rate_uc() is the one place that knows the
-- micro-cent price of a sent email, received email, AI decision and GB-month of storage. billing_month_cost(),
-- billing_gate() and billing_settle() read from billing_rate_uc() instead of duplicating hardcoded 20000 literals.

CREATE OR REPLACE FUNCTION billing_rate_uc(meter text, rate_version smallint, hour timestamptz) RETURNS numeric LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN meter IN ('send','receive') THEN 20000
    WHEN meter='omen' THEN CASE WHEN (billing_rates_in((date_trunc('month', hour AT TIME ZONE 'UTC'))::date)).version >= 3 THEN 0 ELSE 10000 END
    WHEN meter='storage' THEN CASE WHEN c.storage_billing_from IS NULL OR hour < c.storage_billing_from::timestamp AT TIME ZONE 'UTC' THEN 0
      ELSE 25000000::numeric / (1e9 * extract(day FROM date_trunc('month', hour AT TIME ZONE 'UTC') + interval '1 month - 1 day')) END
    ELSE 0 END FROM billing_config c WHERE c.singleton
$$;

-- A month's cost from its charged totals, at that month's allowances and unit rates (billing_rate_uc).
CREATE OR REPLACE FUNCTION billing_month_cost(month date, sent bigint, received bigint, other_uc numeric) RETURNS bigint LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT round(
    billing_rate_uc('send', r.version, month::timestamp AT TIME ZONE 'UTC') * greatest(0, sent - r.free_sent)
    + billing_rate_uc('receive', r.version, month::timestamp AT TIME ZONE 'UTC') * greatest(0, received - r.free_received)
    + other_uc
  )::bigint FROM billing_rates_in(month) r
$$;

-- The gate prices sends only, against the sent allowance and billing_rate_uc('send', ...).
CREATE OR REPLACE FUNCTION billing_gate(wid text, emails int, sim boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE p jsonb := billing_position(wid); avail bigint; charge bigint; ok boolean;
  now_hour timestamptz := date_trunc('hour', now(), 'UTC');
  rate_ver smallint := (billing_rates_in((date_trunc('month', now() AT TIME ZONE 'UTC'))::date)).version;
BEGIN
  IF sim AND NOT (SELECT bill_simulated FROM billing_config WHERE singleton) THEN emails := 0; END IF;
  avail := (p->>'availableUc')::bigint;
  charge := round(billing_rate_uc('send', rate_ver, now_hour) * greatest(0, emails - (p->>'freeSentLeft')::int))::bigint;
  ok := p->>'mode'<>'prepaid' OR avail-charge >= 0;           -- debt blocks even free sends
  IF p->>'enforcement'='enforce' AND p->>'mode'='prepaid' AND (p->>'canRecharge')::boolean AND avail-charge < (p->>'thresholdUc')::bigint THEN
    INSERT INTO jobs(id,type,workspace_id,payload) VALUES ('billing.recharge:'||wid,'billing.recharge',wid,'{}')
      ON CONFLICT (id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL
      WHERE jobs.status IN ('completed','failed');
  END IF;
  RETURN p || jsonb_build_object('ok',ok,'enforced',p->>'enforcement'='enforce' AND p->>'mode'='prepaid','requiredUc',charge::text);
END $$;

-- 386's settler, reading send/receive unit rates in the meter breakdown from billing_rate_uc().
CREATE OR REPLACE FUNCTION billing_settle(wid text, cutoff timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; cfg billing_config; cut timestamptz := least(cutoff, date_trunc('hour', now(), 'UTC'));
  deltas billing_delta[]; counted billing_counted[]; n_rows int; p record; money bigint; take bigint; promo_left bigint; total bigint; recharging boolean;
  det jsonb; posted jsonb; ids text[] := '{}'; charged_any boolean := false; money_total bigint := 0; would_be_total bigint := 0;
  this_month date := (date_trunc('month', now() AT TIME ZONE 'UTC'))::date; mine billing_months; rates billing_rates;
BEGIN
  INSERT INTO billing_accounts(workspace_id) VALUES (wid) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM billing_accounts WHERE workspace_id=wid FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN '{"busy":true}'; END IF;
  SELECT * INTO cfg FROM billing_config WHERE singleton;
  WITH open AS (SELECT u.hour, u.meter, u.rate_version, u.quantity, u.settled_quantity, u.refunds FROM billing_open o
      JOIN billing_usage_hourly u ON u.workspace_id=o.workspace_id AND u.hour=o.hour AND u.meter=o.meter AND u.rate_version=o.rate_version
      WHERE o.workspace_id=wid AND o.hour < cutoff AND (u.quantity <> u.settled_quantity OR u.refunds <> '{}')
        AND (u.hour < cut OR EXISTS (SELECT FROM jsonb_object_keys(u.refunds) k WHERE to_timestamp(ltrim(k, 's')::bigint) < cut))
      ORDER BY u.hour, u.meter, u.rate_version FOR UPDATE OF u SKIP LOCKED),
    part AS (SELECT o.*, CASE WHEN o.hour < cut THEN o.refunds ELSE (SELECT jsonb_object_agg(k, v) FROM jsonb_each(o.refunds) x(k, v)
               WHERE to_timestamp(ltrim(k, 's')::bigint) < cut) END AS taken FROM open o),
    closed AS (UPDATE billing_usage_hourly u
      SET settled_quantity = CASE WHEN r.hour < cut THEN r.quantity ELSE r.settled_quantity + (SELECT sum(v::bigint) FROM jsonb_each_text(r.taken) x(k, v)) END,
          refunds = CASE WHEN r.hour < cut THEN '{}' ELSE r.refunds - ARRAY(SELECT jsonb_object_keys(r.taken)) END
      FROM part r WHERE u.workspace_id=wid AND u.hour=r.hour AND u.meter=r.meter AND u.rate_version=r.rate_version
      RETURNING r.hour, r.meter, r.rate_version, u.settled_quantity - r.settled_quantity AS delta, r.taken)
  SELECT count(DISTINCT (c.hour, c.meter, c.rate_version))::int, array_agg(d ORDER BY d.hour, d.meter) INTO n_rows, deltas
    FROM closed c CROSS JOIN LATERAL billing_row_deltas(c.hour, c.meter, c.rate_version, c.delta, c.taken) d;
  IF coalesce(n_rows, 0) = 0 THEN PERFORM billing_open_prune(wid, cutoff); RETURN jsonb_build_object('entries', 0); END IF;
  counted := ARRAY(SELECT x FROM billing_classify(wid, deltas, NOT (cfg.mode = 'enforce' AND a.mode = 'prepaid')) x);
  -- Forgiven units: added, or taken by refunds (never more than are there). Only the settler writes them, under the
  -- account's lock.
  WITH ch AS (SELECT x.hour, x.meter, sum(x.forgive)::bigint AS d FROM unnest(counted) x WHERE x.forgive <> 0 GROUP BY 1, 2),
  up AS (UPDATE billing_forgiven f SET units = f.units + ch.d FROM ch WHERE f.workspace_id = wid AND f.hour = ch.hour AND f.meter = ch.meter RETURNING f.hour, f.meter)
  INSERT INTO billing_forgiven (workspace_id, hour, meter, units)
    SELECT wid, ch.hour, ch.meter, ch.d FROM ch WHERE NOT EXISTS (SELECT FROM up WHERE up.hour = ch.hour AND up.meter = ch.meter) ORDER BY 2, 3;
  promo_left := a.promo_uc;
  FOR p IN SELECT * FROM billing_priced(wid, counted) ORDER BY cost_uc - posted_uc >= 0, month LOOP
    money := p.cost_uc - p.posted_uc; rates := billing_rates_in(p.month);
    take := CASE WHEN money < 0 THEN -least(p.promo_uc, -money) ELSE least(promo_left, money) END;
    promo_left := promo_left - take;
    -- Per meter: units settled, units beyond the allowance (or charged, for Omens and storage) and their cost; for a
    -- month not charged, what they would have cost.
    WITH d AS (SELECT x.* FROM unnest(counted) x WHERE (date_trunc('month', x.hour AT TIME ZONE 'UTC'))::date = p.month),
    m AS (SELECT d.meter, sum(d.units)::bigint AS q, coalesce(sum(d.units) FILTER (WHERE d.charged OR NOT p.charged), 0)::bigint AS counted,
            coalesce(sum(d.uc) FILTER (WHERE d.charged OR NOT p.charged), 0) AS rated, min(d.hour) AS first, max(d.hour) AS last FROM d GROUP BY d.meter),
    v AS (SELECT m.*, CASE WHEN m.meter IN ('send', 'receive') THEN greatest(0, n - f) - greatest(0, n - m.counted - f)
                           WHEN m.meter IN ('omen', 'storage') THEN m.counted ELSE 0 END AS payable
          FROM m CROSS JOIN LATERAL (SELECT CASE m.meter WHEN 'send' THEN p.sent + CASE WHEN p.charged THEN 0 ELSE p.uncharged_sent END
            WHEN 'receive' THEN p.received + CASE WHEN p.charged THEN 0 ELSE p.uncharged_received END END AS n,
            CASE m.meter WHEN 'send' THEN rates.free_sent WHEN 'receive' THEN rates.free_received END AS f) t)
    SELECT jsonb_build_object('meters', jsonb_object_agg(v.meter, jsonb_build_object('quantity', v.q, 'payable', v.payable,
        'costUc', CASE WHEN v.meter IN ('send', 'receive') THEN round(v.payable * billing_rate_uc(v.meter, rates.version, p.month::timestamp AT TIME ZONE 'UTC'))::bigint WHEN v.meter IN ('omen', 'storage') THEN v.rated ELSE 0 END)),
      'costUc', (CASE WHEN p.charged THEN money ELSE p.would_be_uc - p.prior_would_be_uc END)::text, 'charged', p.charged,
      'from', min(v.first), 'to', max(v.last) + interval '1 hour', 'usageMonth', to_char(p.month, 'YYYY-MM'), 'rateVersion', rates.version) INTO det FROM v;
    posted := billing_post(wid, 'usage', 'usage:'||wid||':'||to_char(p.month, 'YYYY-MM')||':'||txid_current()||':'||extract(epoch FROM clock_timestamp()),
      -(money - take), -take, det, 'system');
    INSERT INTO billing_months AS b (workspace_id, month, sent, received, other_uc, uncharged_sent, uncharged_received, uncharged_other_uc, posted_uc, promo_uc)
      VALUES (wid, p.month, p.sent, p.received, p.other_uc, p.uncharged_sent, p.uncharged_received, p.uncharged_other_uc, p.cost_uc, p.promo_uc + take)
      ON CONFLICT (workspace_id, month) DO UPDATE SET sent=excluded.sent, received=excluded.received, other_uc=excluded.other_uc,
        uncharged_sent=excluded.uncharged_sent, uncharged_received=excluded.uncharged_received, uncharged_other_uc=excluded.uncharged_other_uc,
        posted_uc=excluded.posted_uc, promo_uc=excluded.promo_uc;
    ids := ids || (posted->>'entryId');
    charged_any := charged_any OR p.charged; money_total := money_total + money; would_be_total := would_be_total + p.would_be_uc - p.prior_would_be_uc;
  END LOOP;
  -- The account's month counters of the settler before this one, kept for what still reads them (a Worker of the
  -- previous release during a deploy, an operator's view of the account): this month's charged units and what its
  -- settled usage is worth.
  SELECT * INTO mine FROM billing_months WHERE workspace_id=wid AND month=this_month;
  UPDATE billing_accounts SET free_month=this_month, free_sent_used=least(coalesce(mine.sent, 0), 2147483647)::int,
      free_received_used=least(coalesce(mine.received, 0), 2147483647)::int,
      month_spend_uc=coalesce(billing_month_cost(this_month, mine.sent + mine.uncharged_sent, mine.received + mine.uncharged_received, mine.other_uc + mine.uncharged_other_uc), 0)
    WHERE workspace_id=wid RETURNING * INTO a;
  -- Notices and auto-recharge, as before, for real money only: enforce, prepaid.
  IF cfg.mode='enforce' AND a.mode='prepaid' THEN
    total := a.balance_uc + a.promo_uc;
    recharging := a.recharge_enabled AND a.recharge_disabled_at IS NULL AND a.stripe_payment_method IS NOT NULL;
    IF total > 0 AND total < a.low_balance_uc AND a.low_since IS NULL AND NOT recharging THEN
      UPDATE billing_accounts SET low_since=now() WHERE workspace_id=wid RETURNING * INTO a;
      PERFORM billing_notice(wid, 'low_balance', 'low_balance:'||wid||':'||a.low_since, jsonb_build_object('totalUc', total::text));
    END IF;
    -- Sending pauses once the balance is gone and this month's free sends are used; free received mail doesn't keep it going.
    IF total <= 0 AND coalesce(mine.sent, 0) >= (billing_rates_in(this_month)).free_sent AND a.empty_since IS NULL THEN
      UPDATE billing_accounts SET empty_since=now() WHERE workspace_id=wid RETURNING * INTO a;
      PERFORM billing_notice(wid, 'sends_paused', 'sends_paused:'||wid||':'||a.empty_since,
        jsonb_build_object('totalUc', total::text, 'unpaidSince', a.unpaid_since));
    END IF;
    IF recharging AND a.recharge_pending_attempt IS NULL AND total < a.recharge_threshold_uc THEN
      INSERT INTO jobs(id,type,workspace_id,payload) VALUES ('billing.recharge:'||wid,'billing.recharge',wid,'{}')
        ON CONFLICT (id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL
        WHERE jobs.status IN ('completed','failed');
    END IF;
  END IF;
  PERFORM billing_open_prune(wid, cutoff);
  RETURN jsonb_build_object('entries', n_rows, 'costUc', (CASE WHEN charged_any THEN money_total ELSE would_be_total END)::text,
    'charged', charged_any, 'entryId', ids[1], 'entryIds', to_jsonb(ids));
END $$;
