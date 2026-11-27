SET LOCAL lock_timeout='2s';

-- Set this one UTC instant before merging. Reconnecting or changing a workspace's owner does not change its cohort.
CREATE FUNCTION hosted_strict_since() RETURNS timestamptz LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT timestamptz '2099-01-01 00:00:00+00'
$$;

CREATE FUNCTION hosted_week_until(wid text) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT w.created_at + interval '168 hours' FROM workspaces w
  JOIN provider_connections pc ON pc.workspace_id=w.id AND pc.kind='shared'
  WHERE w.id=wid AND NOT w.exempt_hosted_quotas AND w.created_at>=hosted_strict_since()
    AND now()<w.created_at+interval '168 hours'
    AND NOT EXISTS (SELECT FROM billing_payment_attempts p WHERE p.workspace_id=w.id
      AND p.kind IN ('checkout','saved_card','recharge') AND p.status='succeeded' AND p.amount_uc>=2000000000)
$$;

CREATE FUNCTION hosted_verified_member(wid text, address text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT FROM workspace_members m JOIN nightmail_users u ON u.id=m.user_id
    WHERE m.workspace_id=wid AND u.email_verified AND lower(u.email)=lower(address))
$$;

-- Only positions in the addressed envelope; no new copy of any email address. Membership is fixed at dispatch,
-- but an attempt is not evidence until the existing Hosted acceptance predicate recognizes it.
ALTER TABLE sending_emails ADD COLUMN evaluation_outside smallint[];
CREATE FUNCTION hosted_evaluation_outside(wid text, destinations jsonb) RETURNS smallint[] LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS (SELECT FROM workspaces w JOIN provider_connections pc ON pc.workspace_id=w.id AND pc.kind='shared'
    LEFT JOIN sender_standing s ON s.workspace_id=w.id WHERE w.id=wid AND w.created_at>=hosted_strict_since()
    AND NOT w.exempt_hosted_quotas AND coalesce(s.phase,'calibrating')<>'graded') THEN ARRAY(
      SELECT i::smallint FROM jsonb_array_elements_text(destinations) WITH ORDINALITY d(address,i)
      WHERE lower(address) NOT LIKE '%@simulator.amazonses.com' AND NOT hosted_verified_member(wid,address)) END
$$;

CREATE TABLE hosted_evaluation_recipients (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  address_hash bytea NOT NULL, domain_hash bytea NOT NULL, email_id text NOT NULL, position smallint NOT NULL, resolved boolean NOT NULL,
  PRIMARY KEY(workspace_id,address_hash)
);

ALTER TABLE sender_standing ADD COLUMN restrict_on_probation boolean NOT NULL DEFAULT false,
  ADD COLUMN outside_hold boolean NOT NULL DEFAULT false, ADD COLUMN other_restrict boolean NOT NULL DEFAULT false;

-- One lookup per owner at lease; at claim the connection lock orders this lookup against applyChange.
-- marketing is an independent hold (including one inherited from a sibling); outside applies only to this workspace.
CREATE FUNCTION hosted_hold_scope(wid text) RETURNS TABLE(marketing boolean, outside boolean) LANGUAGE sql STABLE AS $$
  SELECT coalesce(pc.marketing_held_at IS NOT NULL OR s.marketing_hold OR (s.step IN ('restrict','pause')
      AND NOT coalesce(s.release_until>now() AND s.release_percent IS NOT NULL,false)
      AND (NOT s.outside_hold OR s.other_restrict)),false) OR hosted_sponsor_hold(wid) IS NOT NULL,
    coalesce(s.outside_hold AND NOT w.exempt_hosted_quotas AND w.created_at>=hosted_strict_since(),false)
  FROM (SELECT wid AS id) k LEFT JOIN provider_connections pc ON pc.workspace_id=k.id AND pc.kind='shared'
  LEFT JOIN workspaces w ON w.id=pc.workspace_id LEFT JOIN sender_standing s ON s.workspace_id=pc.workspace_id
$$;

CREATE FUNCTION hosted_has_outside(wid text,destinations jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT FROM jsonb_array_elements_text(destinations) d WHERE NOT hosted_verified_member(wid,d))
$$;

CREATE FUNCTION hosted_claim_open(wid text, held_stream boolean, destinations jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM FROM provider_connections WHERE workspace_id=wid AND paused_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN (SELECT NOT (h.marketing AND held_stream OR h.outside AND hosted_has_outside(wid,destinations))
    FROM hosted_hold_scope(wid) h);
END $$;

-- As in 400, with a ceiling on daily room only: the standing still sets reserve, hourly and minute rates.
CREATE OR REPLACE FUNCTION hosted_allowance_read(wid text,incoming int,marketing int,first_week int,second_week int,mature int,headroom numeric)
RETURNS TABLE(allowance jsonb) LANGUAGE sql STABLE AS $$
 WITH policy AS MATERIALIZED (
   SELECT p.*,w.created_at>=hosted_strict_since() AND NOT w.exempt_hosted_quotas AS strict,hosted_week_until(wid) AS week_until,s.step,coalesce(s.marketing_hold,false) AS operator_hold,
     CASE WHEN s.release_until>now() THEN s.release_percent END AS release_percent,
     CASE WHEN w.send_cap_override_expires_at IS NULL OR w.send_cap_override_expires_at>now() THEN p.send_cap_override END AS override,
     CASE WHEN NOT p.exempt_hosted_quotas AND (p.send_cap_override IS NULL OR w.send_cap_override_expires_at<=now()) THEN w.quota_sponsor END AS sponsor,
     hosted_base_cap(wid,first_week,second_week,mature) AS full_cap,hosted_sponsor_hold(wid) AS sponsor_hold,
     -- In its evaluation until its first grade (no standing yet included), as hosted-sending.ts probationReason says.
     coalesce(s.phase,'calibrating')<>'graded' AS evaluating
   FROM hosted_admission_policy_read p JOIN workspaces w ON w.id=p.workspace_id LEFT JOIN sender_standing s ON s.workspace_id=p.workspace_id
   WHERE p.workspace_id=wid
 ), capped AS (
   -- A resume's reduced limit applies without a base limit too (least ignores the NULL): only an exempt workspace has none.
   SELECT p.*,CASE WHEN (p.full_cap IS NOT NULL OR NOT p.exempt_hosted_quotas) AND p.restore_cap IS NOT NULL AND p.restore_until>now() THEN p.restore_until END AS restored_until,
     CASE WHEN (p.full_cap IS NOT NULL OR NOT p.exempt_hosted_quotas) AND p.restore_cap IS NOT NULL AND p.restore_until>now() THEN least(p.full_cap,p.restore_cap) ELSE p.full_cap END AS cap FROM policy p
 ), siblings AS (
   SELECT wid AS id UNION ALL SELECT w.id FROM workspaces w WHERE w.id<>wid AND w.quota_sponsor=(SELECT sponsor FROM capped)
     AND (w.send_cap_override IS NULL OR w.send_cap_override_expires_at<=now()) AND NOT w.exempt_hosted_quotas
 ), hours AS (
   SELECT h.hour,sum(h.recipients) AS recipients,coalesce(sum(h.marketing) FILTER (WHERE h.workspace_id=wid),0) AS marketing FROM siblings s JOIN hosted_usage_hourly h ON h.workspace_id=s.id
   WHERE incoming>0 AND h.hour BETWEEN date_trunc('hour',now(),'UTC')-interval '23 hours' AND date_trunc('hour',now(),'UTC') AND h.recipients>0 GROUP BY h.hour
 ), usage AS (SELECT hour,sum(recipients) OVER(ORDER BY hour DESC) AS running FROM hours)
 SELECT jsonb_build_object('cap',effective.cap,'marketingCap',CASE WHEN hr.binding THEN u.used+greatest(0,hr.cap-hr.used) ELSE m.cap END,'marketingDayCap',m.cap,'used',u.used,
   'resetAt',CASE WHEN effective.week_cap IS NOT NULL AND (p.cap IS NULL OR p.cap>effective.week_cap) AND u.used+incoming>effective.cap THEN
     -- A batch that cannot fit the independent limits even with empty buckets has no time to promise.
     CASE WHEN incoming>p.cap OR marketing>stream.cap OR marketing>hr.cap THEN NULL ELSE greatest(
       least(CASE WHEN incoming<=effective.cap THEN u.reset END,greatest(p.week_until,u.standing_reset)),
       CASE WHEN marketing>0 AND hr.used+marketing>hr.cap THEN hr.reset END) END
     ELSE u.reset END,
   'nextChangeAt',least(p.week_until,p.restored_until,coalesce(u.first_expiry,date_trunc('hour',now(),'UTC')+interval '24 hours'),CASE WHEN hr.binding THEN hr.reset END),
   'marketingHourCap',hr.cap,'marketingHourUsed',hr.used,'marketingHourResetAt',CASE WHEN hr.cap IS NOT NULL THEN hr.reset END,
   'pauseReason',coalesce(p.pause_reason,CASE WHEN p.sponsor_hold='pause' THEN 'Hosted sending is paused for another workspace of this account. Bane reviews it before this workspace can send.' END),
   'pendingCapOverride',p.pending_cap_override,'exemptHostedQuotas',p.exempt_hosted_quotas,
   'nextCap',CASE WHEN p.restored_until IS NOT NULL AND after_restore.cap>effective.cap THEN after_restore.cap END,'nextCapAt',CASE WHEN p.restored_until IS NOT NULL AND after_restore.cap>effective.cap THEN p.restored_until END,
   'marketingHeld',coalesce((p.step IN ('restrict','pause') AND p.release_percent IS NULL) OR p.operator_hold,false) OR p.marketing_held_at IS NOT NULL OR p.sponsor_hold IS NOT NULL,
   'marketingHoldReason',CASE WHEN NOT coalesce((p.step IN ('restrict','pause') AND p.release_percent IS NULL) OR p.operator_hold,false) THEN p.marketing_hold_reason END,'step',coalesce(p.step,'ok')) || CASE WHEN p.strict THEN jsonb_build_object('strictEvaluation',p.evaluating,
     'weekBinding',effective.week_cap IS NOT NULL AND (p.cap IS NULL OR p.cap>effective.week_cap),
     'outsideHold',scope.outside_held,'streamHeld',scope.stream_held,
     'standingCap',p.cap,'standingMarketingCap',least(stream.cap,CASE WHEN hr.cap IS NOT NULL THEN u.used+greatest(0,hr.cap-hr.used) END)) ELSE '{}'::jsonb END
 FROM capped p LEFT JOIN LATERAL hosted_hold_scope(wid) scope(stream_held,outside_held) ON p.strict
   CROSS JOIN LATERAL (SELECT CASE WHEN p.week_until IS NOT NULL THEN 500 END AS week_cap,least(p.cap,CASE WHEN p.week_until IS NOT NULL THEN 500 END) AS cap) effective
   CROSS JOIN LATERAL (SELECT least(p.full_cap,CASE WHEN p.week_until>p.restored_until THEN 500 END) AS cap) after_restore
   CROSS JOIN LATERAL (SELECT CASE WHEN p.cap IS NOT NULL THEN
     (greatest(0,p.cap-CASE WHEN p.override IS NOT NULL THEN ceil(p.cap*headroom/100)::int WHEN p.evaluating THEN 0 ELSE greatest(least(100,p.cap),ceil(p.cap*headroom/100)::int) END)
       *coalesce(p.release_percent,100)/100) END AS cap) stream CROSS JOIN LATERAL (SELECT least(stream.cap,effective.week_cap) AS cap) m CROSS JOIN LATERAL (
   SELECT coalesce(max(running),0) AS used,min(hour)+interval '24 hours' AS first_expiry,
     max(hour) FILTER(WHERE running+least(incoming,effective.cap)>effective.cap OR (marketing>0 AND running+least(marketing,m.cap)>m.cap))+interval '24 hours' AS reset,
     max(hour) FILTER(WHERE running+least(incoming,p.cap)>p.cap OR (marketing>0 AND running+least(marketing,stream.cap)>stream.cap))+interval '24 hours' AS standing_reset
     FROM usage) u
   -- Marketing per hour, per workspace (parallel campaigns and direct marketing share it): max(25, limit / 4). It is
   -- folded into marketingCap when it binds, so every check of marketingCap (one-statement admission, the session
   -- path, campaign release) enforces it, and nextChangeAt says when the next hour starts.
   CROSS JOIN LATERAL (SELECT c.cap,c.used,date_trunc('hour',now(),'UTC')+interval '1 hour' AS reset,c.cap IS NOT NULL AND u.used+greatest(0,c.cap-c.used)<m.cap AS binding FROM (
     SELECT CASE WHEN p.cap IS NOT NULL THEN greatest(25,p.cap/4) END AS cap,
       coalesce((SELECT h.marketing FROM hours h WHERE h.hour=date_trunc('hour',now(),'UTC')),0) AS used) c) hr
$$;


-- Staff views historically show the stored standing. For the strict cohort show the same effective
-- number as customer admission, including overrides and restores. No usage scan (incoming=0).
CREATE FUNCTION hosted_display_cap(wid text, stored int) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS (SELECT FROM workspaces w JOIN provider_connections pc ON pc.workspace_id=w.id
    WHERE w.id=wid AND pc.kind='shared' AND NOT w.exempt_hosted_quotas AND w.created_at>=hosted_strict_since())
    THEN (SELECT (allowance->>'cap')::int FROM hosted_allowance_read(wid,0,0,500,NULL,NULL,10))
    ELSE stored END
$$;

-- As in 501, with destination-aware holds inside the locked admission and idempotency decision.
CREATE OR REPLACE FUNCTION send_admission(wid text, actor jsonb, req jsonb, assets jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  stage text := req->>'stage'; lim jsonb := req->'limits'; mails jsonb := coalesce(req->'mails','[]');
  sim boolean := (req->>'simulated')::boolean; mx boolean := (req->>'multiTenant')::boolean; regional boolean := (req->>'regional')::boolean;
  cost int := coalesce((req->>'cost')::int,0); marketing int := coalesce((req->>'marketing')::int,0);
  domains jsonb := coalesce(actor->'domains','[]'); claimed boolean := false; previous jsonb; d jsonb;
  -- Billing applies to Hosted sending, never to the platform's own workspace.
  billed boolean := mx AND wid IS DISTINCT FROM req->>'platformWorkspace';
  s record; h jsonb; b jsonb; quota numeric; projected int; cap int; conn jsonb; routes jsonb := '{}'; facts jsonb;
  locked jsonb := '[]'; resolved jsonb := '[]'; m jsonb; i int := -1; host text; reg text; r jsonb; c jsonb;
  obs jsonb; ses jsonb; needs_dmarc boolean; used bigint; incoming int; reserved boolean; hour_cap int; files jsonb;
  outstanding jsonb; capped boolean; scheduled boolean := stage='send' AND req ? 'scheduledAt'; at timestamptz;
  bpol jsonb := req->'builtin'; bd builtin_domains%ROWTYPE; bi int; bown text; bn int; bused record;
BEGIN
  IF jsonb_typeof(req->'claim')='object' THEN
    previous := idempotency_claim(wid, actor->>'id', req->'claim'->>'path', req->'claim'->>'key', req->'claim'->>'hash', req->'claim'->'receipt');
    IF previous IS NOT NULL THEN RETURN previous; END IF;
    claimed := true;
  END IF;
  <<decide>> BEGIN
    -- A scheduled single send: a UTC instant from a minute ago (a sender's clock) to the horizon. Checked after the claim, so
    -- an exact retry replays its receipt however late it comes.
    IF scheduled THEN
      at := (req->>'scheduledAt')::timestamptz;
      IF at < clock_timestamp()-make_interval(secs=>(lim->'schedule'->>'skewSeconds')::int) OR at > clock_timestamp()+make_interval(secs=>(lim->'schedule'->>'horizonSeconds')::int) THEN
        d := jsonb_build_object('code','INVALID_SCHEDULE'); EXIT decide;
      END IF;
    END IF;
    IF req->>'locks'='take' THEN
      IF req->'campaign' ? 'id' THEN
        SELECT revision,archived_at IS NOT NULL AS archived INTO s FROM sending_campaigns WHERE workspace_id=wid AND id=req->'campaign'->>'id' FOR UPDATE;
        IF NOT FOUND THEN d := jsonb_build_object('code','NOT_FOUND'); EXIT decide; END IF;
        IF s.archived THEN d := jsonb_build_object('code','CAMPAIGN_ARCHIVED'); EXIT decide; END IF;
        IF s.revision<>(req->'campaign'->>'revision')::int THEN d := jsonb_build_object('code','CAMPAIGN_LOCKED'); EXIT decide; END IF;
      END IF;
      INSERT INTO job_schedule(workspace_id) VALUES(wid) ON CONFLICT(workspace_id) DO UPDATE SET turn=job_schedule.turn WHERE false;
    END IF;

    IF stage='reserve' THEN
      -- Unreleased intents of every active or resumable campaign plus their rows still queued, computed by the caller.
      outstanding := req->'outstanding'; incoming := coalesce((req->>'incoming')::int,0);
      IF (outstanding->>'total')::bigint+incoming>(lim->>'campaignPendingWorkspace')::bigint OR (outstanding->>'key')::bigint+incoming>(lim->>'campaignPendingKey')::bigint THEN
        d := jsonb_build_object('code','CAMPAIGN_PENDING_LIMIT_EXCEEDED'); END IF;
      EXIT decide;
    END IF;

    IF req->>'locks'='none' THEN SELECT default_region,enabled_regions INTO s FROM ses_installation_settings WHERE workspace_id=wid;
    ELSE SELECT default_region,enabled_regions INTO s FROM ses_installation_settings WHERE workspace_id=wid FOR SHARE; END IF;

    IF stage='release' THEN
      IF mx THEN
        h := (SELECT allowance FROM hosted_allowance(wid,CASE WHEN sim THEN 0 ELSE 1 END,0,(req->'caps'->>'firstWeek')::int,NULL,NULL,(req->>'headroom')::numeric));
        IF jsonb_typeof(h)='object' AND billed THEN b := billing_gate(wid,0,sim); END IF;
        IF h->>'pauseReason' IS NOT NULL THEN d := jsonb_build_object('code','HOSTED_SENDING_PAUSED','reason',h->>'pauseReason'); EXIT decide; END IF;
        IF NOT sim AND (h->>'outsideHold')::boolean AND (req->>'reviewId' IS NULL OR EXISTS (
          SELECT FROM sending_review_recipients r WHERE r.review_id=req->>'reviewId' AND r.ordinal>coalesce((req->>'expanded')::int,0)
            AND NOT hosted_verified_member(wid,r.recipient->>'email'))) THEN
          d := jsonb_build_object('code','MARKETING_HELD','outside',true); EXIT decide;
        END IF;
        IF NOT sim AND coalesce((coalesce(h->>'streamHeld',h->>'marketingHeld'))::boolean,false) THEN d := jsonb_build_object('code','MARKETING_HELD','reason',h->>'marketingHoldReason'); EXIT decide; END IF;
      END IF;
      IF jsonb_typeof(mails->0->'binding')='object' AND NOT review_binding_ready(wid,mails->0->>'from',mails->0->>'region',mails->0->'binding',sim,req->'platform') THEN
        d := jsonb_build_object('code','SENDER_BINDING_CHANGED'); EXIT decide;
      END IF;
      EXIT decide;
    END IF;

    -- send, launch and prepare.
    IF s.default_region IS NULL THEN d := jsonb_build_object('code','REGION_SETTINGS_NOT_INITIALIZED'); EXIT decide; END IF;
    IF mx AND stage<>'prepare' THEN
      h := (SELECT allowance FROM hosted_allowance(wid,cost,marketing,(req->'caps'->>'firstWeek')::int,NULL,NULL,(req->>'headroom')::numeric));
    END IF;
    IF regional AND stage<>'prepare' THEN
      SELECT coalesce(jsonb_object_agg(k.host,to_jsonb(x)),'{}') INTO routes
        FROM (SELECT DISTINCT lower(e->>'host') AS host FROM jsonb_array_elements(mails) e) k CROSS JOIN LATERAL regional_sender(wid,k.host,sim,req->'platform') x;
    ELSIF mx AND stage<>'prepare' THEN
      EXECUTE format('SELECT to_jsonb(c) FROM %I c WHERE c.workspace_id=$1 AND c.region=$2', CASE WHEN sim THEN 'regional_simulated_connections' ELSE 'regional_sending_connections' END)
        INTO conn USING wid, coalesce(mails->0->>'region',s.default_region);
      SELECT coalesce(jsonb_object_agg(v.key,true),'{}') INTO routes FROM (
        SELECT DISTINCT lower(e->>'host')||':'||coalesce(e->>'region',s.default_region) AS key FROM jsonb_array_elements(mails) e
        WHERE EXISTS (SELECT FROM verified_sending_domains v WHERE v.workspace_id=wid AND v.region=coalesce(e->>'region',s.default_region)
          AND right('.'||lower(e->>'host'),length(v.name)+1)='.'||v.name)) v;
    END IF;
    -- A campaign being prepared keeps the binding it was reviewed with: checked, with the sender claim it locks, before
    -- any attachment is locked. One reviewed without a binding keeps its region (below).
    IF stage='prepare' AND jsonb_typeof(mails->0->'binding')='object'
        AND NOT review_binding_ready(wid,mails->0->>'from',mails->0->>'region',mails->0->'binding',sim,req->'platform') THEN
      d := jsonb_build_object('code','SENDER_BINDING_CHANGED'); EXIT decide;
    END IF;
    -- Built-in domains (src/builtin-domain.ts): mail from the workspace's own <label>.<parent> host is plain transactional
    -- mail sent now, to the recipients the configured scope allows (req->'builtin': scope, perDay, perMinute), and only
    -- while the workspace has no verified domain of its own. Its recipients are counted from sending_emails after the send
    -- locks, so a concurrent send has committed. A path that admits such mail without naming its recipients is refused.
    IF stage IN ('send','launch','prepare') THEN
      SELECT * INTO bd FROM builtin_domains WHERE workspace_id=wid;
      IF FOUND THEN
        bi := (SELECT min(o-1) FROM jsonb_array_elements(mails) WITH ORDINALITY e(v,o) WHERE lower(v->>'host')=bd.name OR right(lower(v->>'host'),length(bd.name)+1)='.'||bd.name);
      END IF;
      IF bi IS NOT NULL THEN
        IF bd.revoked_at IS NOT NULL THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_REVOKED','item',bi,'host',bd.name); EXIT decide; END IF;
        IF jsonb_typeof(bpol) IS DISTINCT FROM 'object' THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_UNAVAILABLE','item',bi,'host',bd.name); EXIT decide; END IF;
        i := (SELECT min(o-1) FROM jsonb_array_elements(mails) WITH ORDINALITY e(v,o) WHERE right(lower(v->>'host'),length(bd.name)+1)='.'||bd.name);
        IF i IS NOT NULL THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_UNSUPPORTED','item',i,'field','from','host',bd.name); EXIT decide; END IF;
        SELECT dc.name INTO bown FROM domain_claims dc WHERE dc.workspace_id=wid AND dc.sending_state IN ('verified','lost') AND dc.name<>bd.name ORDER BY dc.name LIMIT 1;
        IF bown IS NOT NULL THEN d := jsonb_build_object('code','OWN_DOMAIN_VERIFIED','item',bi,'host',bown,'builtin',bd.name); EXIT decide; END IF;
        IF stage<>'send' THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_UNSUPPORTED','item',bi,'field','campaign','host',bd.name); EXIT decide; END IF;
        IF scheduled THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_UNSUPPORTED','item',bi,'field','scheduledAt','host',bd.name); EXIT decide; END IF;
        i := (SELECT min(o-1) FROM jsonb_array_elements(mails) WITH ORDINALITY e(v,o) WHERE lower(v->>'host')=bd.name AND v->>'kind' IS DISTINCT FROM 'transactional');
        IF i IS NOT NULL THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_UNSUPPORTED','item',i,'field','kind','host',bd.name); EXIT decide; END IF;
        i := (SELECT min(o-1) FROM jsonb_array_elements(mails) WITH ORDINALITY e(v,o) WHERE lower(v->>'host')=bd.name AND jsonb_array_length(coalesce(v->'attachments','[]'))>0);
        IF i IS NOT NULL THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_UNSUPPORTED','item',i,'field','attachments','host',bd.name); EXIT decide; END IF;
        i := (SELECT min(o-1) FROM jsonb_array_elements(mails) WITH ORDINALITY e(v,o) WHERE lower(v->>'host')=bd.name AND jsonb_typeof(v->'recipients') IS DISTINCT FROM 'array');
        IF i IS NOT NULL THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_UNAVAILABLE','item',i,'host',bd.name); EXIT decide; END IF;
        IF bpol->>'scope'='members' THEN
          i := (SELECT min(o-1) FROM jsonb_array_elements(mails) WITH ORDINALITY e(v,o) WHERE lower(v->>'host')=bd.name
            AND EXISTS (SELECT FROM jsonb_array_elements_text(v->'recipients') x(email) WHERE NOT EXISTS (
              SELECT FROM workspace_members wm JOIN nightmail_users u ON u.id=wm.user_id WHERE wm.workspace_id=wid AND u.email_verified AND lower(u.email)=lower(x.email))));
          IF i IS NOT NULL THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_RECIPIENT','item',i,'host',bd.name); EXIT decide; END IF;
        END IF;
        bn := (SELECT coalesce(sum(jsonb_array_length(v->'recipients')),0) FROM jsonb_array_elements(mails) v WHERE lower(v->>'host')=bd.name);
        SELECT coalesce(sum(x.n) FILTER (WHERE x.created_at>clock_timestamp()-interval '1 minute'),0) AS minute, coalesce(sum(x.n),0) AS day,
            min(x.created_at) FILTER (WHERE x.created_at>clock_timestamp()-interval '1 minute') AS minute_from, min(x.created_at) AS day_from INTO bused
          FROM (SELECT e.created_at,jsonb_array_length(e.to_addresses)+jsonb_array_length(e.cc_addresses)+jsonb_array_length(e.bcc_addresses) AS n
            FROM sending_emails e WHERE e.workspace_id=wid AND e.created_at>clock_timestamp()-interval '24 hours' AND lower(split_part(e.from_address,'@',2))=bd.name) x;
        IF bused.minute+bn>(bpol->>'perMinute')::int THEN
          d := jsonb_build_object('code','BUILTIN_DOMAIN_LIMIT','item',bi,'window','minute','cap',(bpol->>'perMinute')::int,'host',bd.name,
            'resetAt',coalesce(bused.minute_from+interval '1 minute',clock_timestamp()+interval '1 minute')); EXIT decide; END IF;
        IF bused.day+bn>(bpol->>'perDay')::int THEN
          d := jsonb_build_object('code','BUILTIN_DOMAIN_LIMIT','item',bi,'window','day','cap',(bpol->>'perDay')::int,'host',bd.name,
            'resetAt',coalesce(bused.day_from+interval '24 hours',clock_timestamp()+interval '24 hours')); EXIT decide; END IF;
      END IF;
      i := -1;
    END IF;
    -- Attachments last: lock the visible rows the request names, in id order.
    IF jsonb_array_length(assets)>0 THEN
      SELECT coalesce(jsonb_agg(a ORDER BY a.id),'[]') INTO locked FROM (
        SELECT id,size,content_id AS "contentId",content_type AS "contentType" FROM sending_attachments
        WHERE workspace_id=wid AND id IN (SELECT jsonb_array_elements_text(assets)) ORDER BY id FOR UPDATE) a;
    END IF;
    IF jsonb_typeof(h)='object' AND billed AND (req->>'billable')::int>0 THEN b := billing_gate(wid,(req->>'billable')::int,sim); END IF;
    IF (req->>'requireDmarc')::boolean THEN
      SELECT jsonb_object_agg(dc.name,dc.identity-'mx'-'note') INTO facts FROM domain_claims dc
        WHERE dc.workspace_id=wid AND dc.sending_state IN ('verified','lost') AND dc.name IN (SELECT lower(e->>'host') FROM jsonb_array_elements(mails) e);
    END IF;

    IF stage='send' THEN
      -- Billing first: an enforced empty balance refuses whatever else would.
      IF (b->>'enforced')::boolean AND NOT (b->>'ok')::boolean THEN d := jsonb_build_object('code','BALANCE_EXHAUSTED'); EXIT decide; END IF;
      IF jsonb_typeof(h)='object' THEN
        IF h->>'pauseReason' IS NOT NULL THEN d := jsonb_build_object('code','HOSTED_SENDING_PAUSED','reason',h->>'pauseReason'); EXIT decide; END IF;
        IF NOT sim AND (h->>'outsideHold')::boolean AND EXISTS (SELECT FROM jsonb_array_elements(mails) item(v)
          WHERE item.v->'recipients' IS NULL OR hosted_has_outside(wid,item.v->'recipients')) THEN
          d := jsonb_build_object('code','MARKETING_HELD','outside',true); EXIT decide;
        END IF;
        IF marketing>0 AND coalesce((coalesce(h->>'streamHeld',h->>'marketingHeld'))::boolean,false) THEN d := jsonb_build_object('code','MARKETING_HELD','reason',h->>'marketingHoldReason'); EXIT decide; END IF;
        IF h->>'cap' IS NOT NULL THEN
          used := (h->>'used')::bigint;
          reserved := marketing>0 AND marketing+used>(h->>'marketingCap')::bigint;
          hour_cap := (h->>'marketingHourCap')::int;
          IF reserved AND hour_cap IS NOT NULL AND coalesce((h->>'marketingHourUsed')::int,0)+marketing>hour_cap AND cost+used<=(h->>'cap')::bigint THEN
            d := jsonb_build_object('code','SEND_LIMIT_REACHED','window','hour','allowance',h,'incoming',cost,'marketing',marketing); EXIT decide;
          END IF;
          IF cost>0 AND (cost+used>(h->>'cap')::bigint OR reserved) THEN
            d := jsonb_build_object('code','SEND_LIMIT_REACHED','window','day','reserved',reserved,'allowance',h,'incoming',cost,'marketing',marketing);
            -- A top-up cannot open a marketing ramp. Keep its existing refusal when both would bind.
            IF (h->>'weekBinding')::boolean AND cost+used>(h->>'cap')::bigint AND jsonb_typeof(req->'ramp')='object' THEN
              d := coalesce(ramp_refusal(wid,req->'ramp'),d);
            END IF;
            EXIT decide;
          END IF;
        END IF;
      END IF;
      -- The ramp (src/standing-model.ts RAMP): marketing sent now on the shared pool, live, fits in what the workspace's ramp
      -- step has left this hour, shared with its ramping campaigns (ramp_refusal). Only a send that names its marketing
      -- recipients (req->'ramp', admission.ts charges) is asked; transactional mail never is.
      IF jsonb_typeof(h)='object' AND NOT sim AND jsonb_typeof(req->'ramp')='object' THEN
        d := ramp_refusal(wid,req->'ramp');
        IF d IS NOT NULL THEN EXIT decide; END IF;
      END IF;
      IF scheduled THEN
        -- Scheduled mail is charged nothing now (no cost, billable or marketing reaches this call): the limits, the balance
        -- and the queue are checked at its time, when it is admitted again as a send. Now only how many may wait.
        IF (SELECT count(*) FROM sending_emails WHERE workspace_id=wid AND status='scheduled')+jsonb_array_length(mails)>(lim->'schedule'->>'workspace')::int THEN
          d := jsonb_build_object('code','SCHEDULED_EMAIL_LIMIT_EXCEEDED','cap',(lim->'schedule'->>'workspace')::int); EXIT decide;
        END IF;
      ELSE
        -- Outstanding direct mail, a day of what the workspace can send within the floor and the ceiling: the override; on the
        -- shared pool the ceiling when exempt, a day of its pace in good standing (no daily limit, past the growth pace), else
        -- the floor; otherwise a day of the account's own SES quota.
        SELECT p.projected INTO projected FROM direct_pending_load(wid,jsonb_array_length(mails),
          jsonb_array_length(jsonb_path_query_array(mails,'$[*] ? (@.kind == "marketing")'))) p;
        IF jsonb_typeof(h)='object' THEN
          cap := coalesce((h->>'pendingCapOverride')::int,CASE WHEN (h->>'exemptHostedQuotas')::boolean THEN (lim->>'pendingCeiling')::int
            WHEN coalesce(h->'standingCap',h->'cap')='null'::jsonb AND NOT EXISTS (SELECT FROM hosted_growth(wid)) THEN least((lim->>'pendingCeiling')::int,greatest((lim->>'pendingFloor')::int,hosted_pool_pace(wid)::bigint*1440))::int
            ELSE (lim->>'pendingFloor')::int END);
        ELSE
          quota := CASE WHEN mx THEN (SELECT max(l.max_24_hour_send) FROM regional_workspace_limits l WHERE l.workspace_id=wid
              AND EXISTS (SELECT FROM provider_connections pc WHERE pc.workspace_id=wid AND pc.kind='byo'))
            ELSE (SELECT max(max_24_hour_send) FROM sending_region_limits WHERE workspace_id=wid) END;
          cap := least((lim->>'pendingCeiling')::int,greatest((lim->>'pendingFloor')::int,floor(coalesce(quota,0))::int));
        END IF;
        IF projected>cap THEN d := jsonb_build_object('code','PENDING_EMAIL_LIMIT_EXCEEDED','cap',cap); EXIT decide; END IF;
      END IF;
    END IF;

    FOR m IN SELECT * FROM jsonb_array_elements(mails) LOOP
      i := i+1; host := lower(m->>'host');
      -- A built-in sender's From is signed for its parent domain, and its mail is never bulk.
      needs_dmarc := NOT coalesce(host=bd.name,false) AND (m->>'kind'='marketing' OR (stage='send' AND cost>0 AND coalesce((h->>'used')::bigint,0)+cost>=(lim->>'bulkVolume')::int));
      IF stage='prepare' AND jsonb_typeof(m->'binding')='object' THEN
        reg := m->>'region'; c := NULL; -- Its reviewed binding was checked above.
      ELSIF regional AND stage<>'prepare' THEN
        IF domains<>'[]' AND NOT EXISTS (SELECT FROM jsonb_array_elements_text(domains) x WHERE host=lower(x) OR right(host,length(x)+1)='.'||lower(x)) THEN
          d := jsonb_build_object('code','SENDER_DOMAIN_FORBIDDEN','item',i); EXIT decide; END IF;
        r := routes->host; c := r->'connection'; reg := r->>'region';
        IF (r->>'platform_refused')::boolean THEN d := jsonb_build_object('code','PLATFORM_SENDER_REFUSED','item',i); EXIT decide; END IF;
        IF NOT coalesce((r->>'verified')::boolean,false) THEN d := jsonb_build_object('code','SENDER_DOMAIN_NOT_VERIFIED','item',i); EXIT decide; END IF;
        IF m->>'region' IS NOT NULL AND m->>'region'<>reg THEN d := jsonb_build_object('code','SENDER_REGION_MISMATCH','item',i); EXIT decide; END IF;
        IF jsonb_typeof(c)<>'object' THEN d := jsonb_build_object('code','CONNECTION_REQUIRED','item',i,'regional',true); EXIT decide; END IF;
        IF nullif(c->>'pool_tenant_name','') IS NOT NULL AND c->>'pool_tier'='trusted' AND NOT (req->>'trustedPool')::boolean THEN
          d := jsonb_build_object('code','TRUSTED_POOL_DISABLED','item',i); EXIT decide; END IF;
      ELSE
        reg := coalesce(m->>'region',s.default_region);
        IF NOT s.enabled_regions ? reg THEN d := jsonb_build_object('code','REGION_NOT_CONFIGURED','item',i); EXIT decide; END IF;
        IF stage<>'prepare' AND domains<>'[]' AND NOT EXISTS (SELECT FROM jsonb_array_elements_text(domains) x WHERE host=lower(x) OR right(host,length(x)+1)='.'||lower(x)) THEN
          d := jsonb_build_object('code','SENDER_DOMAIN_FORBIDDEN','item',i); EXIT decide; END IF;
        IF mx AND stage<>'prepare' THEN
          IF NOT routes ? (host||':'||reg) THEN d := jsonb_build_object('code','SENDER_DOMAIN_NOT_VERIFIED','item',i); EXIT decide; END IF;
          c := conn;
          IF c->>'region' IS DISTINCT FROM reg THEN d := jsonb_build_object('code','CONNECTION_REQUIRED','item',i,'regional',false); EXIT decide; END IF;
        ELSIF NOT mx AND jsonb_typeof(req->'readiness')='object' AND NOT EXISTS (SELECT FROM ses_region_discovery x WHERE x.workspace_id=wid AND x.region=reg
            AND x.credentials_fingerprint=req->'readiness'->>'fingerprint' AND x.public_url=req->'readiness'->>'target'
            AND x.report->'provisioned'='true' AND x.report#>'{account,sendingEnabled}'='true'
            AND x.report#>'{account,id}'=coalesce(to_jsonb(x.trusted_account_id),'null') AND x.report#>'{resources,topic,arn}'=coalesce(to_jsonb(x.trusted_topic_arn),'null')
            AND x.report->'resources'->(m->>'kind')->'sendingEnabled'='true') THEN
          d := jsonb_build_object('code','SES_SETUP_REQUIRED','item',i); EXIT decide;
        END IF;
      END IF;
      IF mx AND stage<>'prepare' THEN
        IF c->>'pause_reason' IS NOT NULL THEN d := jsonb_build_object('code','HOSTED_SENDING_PAUSED','item',i,'reason',c->>'pause_reason'); EXIT decide; END IF;
        IF NOT sim AND c->>'kind'='shared' AND c->>'tenant_state' IS DISTINCT FROM 'ready' THEN
          d := jsonb_build_object('code','TENANT_NOT_READY','item',i,'failed',c->>'tenant_state'='failed'); EXIT decide; END IF;
        IF (req->>'requireDmarc')::boolean AND c->>'kind'='shared' AND needs_dmarc THEN
          obs := facts->host->'dmarc'; ses := facts->host->'ses';
          IF NOT (coalesce(obs->>'status' IN ('none','quarantine','reject'),false)
              AND coalesce((obs->>'checkedAt')::numeric>=extract(epoch FROM clock_timestamp()-make_interval(hours=>(lim->>'dmarcMaxAgeHours')::int))*1000,false)
              AND (coalesce(ses#>'{DkimAttributes,SigningEnabled}'='true' AND ses#>>'{DkimAttributes,Status}'='SUCCESS',false)
                OR coalesce(nullif(obs->>'alignedMailFrom','')=lower(rtrim(ses#>>'{MailFromAttributes,MailFromDomain}','.')) AND ses#>>'{MailFromAttributes,MailFromDomainStatus}'='SUCCESS',false))) THEN
            d := jsonb_build_object('code','BULK_DMARC_REQUIRED','item',i,'host',host); EXIT decide;
          END IF;
        END IF;
      END IF;
      IF stage='launch' AND c->>'kind'='shared' THEN
        IF (req->>'autoPause')='false' THEN d := jsonb_build_object('code','HOSTED_AUTO_PAUSE_REQUIRED'); EXIT decide; END IF;
        IF coalesce((coalesce(h->>'streamHeld',h->>'marketingHeld'))::boolean,false) THEN d := jsonb_build_object('code','MARKETING_HELD','reason',h->>'marketingHoldReason'); EXIT decide; END IF;
        IF (b->>'enforced')::boolean AND NOT (b->>'ok')::boolean THEN d := jsonb_build_object('code','BALANCE_EXHAUSTED'); EXIT decide; END IF;
      END IF;
      -- The message's attachments: none named twice, then, as stored, all present and within the size and MIME limits SES accepts.
      IF (m->>'duplicate')::boolean THEN d := jsonb_build_object('code','DUPLICATE_ATTACHMENT','item',i); EXIT decide; END IF;
      SELECT coalesce(jsonb_agg(a),'[]') INTO files FROM jsonb_array_elements(locked) a WHERE m->'attachments' ? (a->>'id');
      IF jsonb_array_length(files)<>jsonb_array_length(m->'attachments') THEN d := jsonb_build_object('code','ATTACHMENT_NOT_FOUND','item',i); EXIT decide; END IF;
      IF (SELECT coalesce(sum((a->>'size')::bigint),0) FROM jsonb_array_elements(files) a)>(lim->>'attachmentBytes')::bigint THEN
        d := jsonb_build_object('code','ATTACHMENT_LIMIT_EXCEEDED','item',i); EXIT decide; END IF;
      IF (SELECT count(a->>'contentId')<>count(DISTINCT a->>'contentId') FROM jsonb_array_elements(files) a) THEN
        d := jsonb_build_object('code','DUPLICATE_CONTENT_ID','item',i); EXIT decide; END IF;
      IF EXISTS (SELECT FROM jsonb_array_elements(files) a WHERE length(a->>'contentType')>(lim->>'mimeFieldChars')::int OR a->>'contentType' ~ '[^ -~]'
          OR length(a->>'contentId')>(lim->>'mimeFieldChars')::int) THEN
        d := jsonb_build_object('code','ATTACHMENT_METADATA_INVALID','item',i); EXIT decide; END IF;
      IF stage='send' AND ceil((m->>'bodyBytes')::numeric*(lim->'mime'->>'bodyFactor')::numeric)
          +(SELECT coalesce(sum(ceil((a->>'size')::numeric/3)*4*(lim->'mime'->>'lineFactor')::numeric+(lim->'mime'->>'perAttachment')::numeric),0) FROM jsonb_array_elements(files) a)
          +(lim->'mime'->>'envelope')::numeric>(lim->>'encodedBytes')::numeric THEN
        d := jsonb_build_object('code','ENCODED_MESSAGE_TOO_LARGE','item',i); EXIT decide;
      END IF;
      resolved := resolved||jsonb_build_object('region',reg,'binding',CASE WHEN regional AND stage<>'prepare' THEN r->'binding' END,'connection',c);
    END LOOP;
    -- Content TypeScript found invalid (headers, duplicates, URLs measured locally): reported after every policy rule.
    i := (SELECT min(o-1) FROM jsonb_array_elements(mails) WITH ORDINALITY e(v,o) WHERE (v->>'invalid')::boolean);
    IF i IS NOT NULL THEN d := jsonb_build_object('code','INVALID_CONTENT','item',i); EXIT decide; END IF;
    -- Content the Hosted screen would refuse at dispatch: only mail on a shared connection is screened.
    i := (SELECT min(o-1) FROM jsonb_array_elements(mails) WITH ORDINALITY e(v,o) WHERE (v->>'oversize')::boolean AND resolved->(o::int-1)->'connection'->>'kind'='shared');
    IF i IS NOT NULL THEN d := jsonb_build_object('code','CONTENT_TOO_LARGE_TO_SCREEN','item',i); EXIT decide; END IF;
  END decide;
  IF d IS NOT NULL THEN
    -- A refusal frees the key it claimed, so the same request can be retried.
    IF claimed THEN DELETE FROM sending_idempotency WHERE workspace_id=wid AND actor_key_id=actor->>'id' AND path=req->'claim'->>'path' AND request_key=req->'claim'->>'key'; END IF;
    RETURN d || jsonb_build_object('allowed',false,'billing',b);
  END IF;
  IF stage='release' AND jsonb_typeof(h)='object' THEN
    capped := NOT sim AND h->>'marketingCap' IS NOT NULL;
    RETURN jsonb_build_object('allowed',true,'hostedLeft',CASE WHEN capped THEN greatest(0,(h->>'marketingCap')::bigint-(h->>'used')::bigint) END,'nextChangeAt',h->>'nextChangeAt',
      'billing',CASE WHEN b->>'mode'='prepaid' AND b->>'enforcement'<>'off' THEN jsonb_build_object('enforced',(b->>'enforced')::boolean,'freeSentLeft',(b->>'freeSentLeft')::int,'availableUc',b->>'availableUc',
        'affordable',CASE WHEN (b->>'availableUc')::numeric<0 THEN 0 ELSE (b->>'freeSentLeft')::bigint+floor((b->>'availableUc')::numeric/(req->>'emailUc')::numeric)::bigint END) END);
  END IF;
  RETURN jsonb_build_object('allowed',true,'mails',resolved,'billing',b,'assets',locked,'shared',jsonb_typeof(h)='object');
END $$;
