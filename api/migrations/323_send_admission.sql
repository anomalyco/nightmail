SET LOCAL lock_timeout='2s';
-- One admission decision for every kind of send (code review sending-1). Before this, direct sends were decided by
-- key_admission_decision, which answered only allowed true/false, so TypeScript re-ran every rule to say which one
-- failed; self-hosted, template, mailbox and campaign-test sends, campaign launch and release each had their own
-- TypeScript copy of the rules. send_admission is now the only copy. It returns the first rule that refuses, in one
-- fixed order, with its code, the message it refused (item) and what the error text needs; TypeScript only turns that
-- into the API's error (src/admission.ts). Every limit arrives as a parameter from src/send-limits.ts: no rule's
-- number is written here.
--
-- key_admission_decision and direct_admission_state stay for the Workers still running the previous release during
-- the deploy, and are dropped in the next release.
--
-- stage: send (direct, batch, self-hosted, templates, mailbox, campaign test), launch (a campaign's sender, holds,
-- balance and attachments, before its audience is frozen), reserve (the recipients campaigns may hold outstanding:
-- launch after the audience is frozen, and resume), release (a campaign's next recipients: pause, hold, the reviewed
-- binding, and how many the Hosted limit and the balance afford) and prepare (a campaign being prepared: the reviewed
-- binding, the region's setup and the attachments).
--
-- locks: take (a statement that admits by itself: the campaign row when one is named, then the admission row, then
-- settings), held (the caller holds them through lockSendScope; settings are share-locked here, in order), none (a
-- check outside the caller's send locks: nothing is locked but the sender claim regional_sender reads).
-- Lock order (src/send-scope.ts): campaign, admission (job_schedule), settings, then sender claims, then attachments.
-- A campaign's reviewed sending binding still holds: the sender's closest claim binds it, verified, in the reviewed region,
-- to a ready connection. Campaign preparation and release check it before they write.
CREATE FUNCTION review_binding_ready(wid text, sender text, region text, binding jsonb, sim boolean, platform jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (SELECT FROM regional_sender(wid,lower(split_part(sender,'@',2)),sim,platform) x
    WHERE x.verified AND x.region=review_binding_ready.region AND x.connection IS NOT NULL AND x.binding=review_binding_ready.binding
      AND (sim OR x.connection->>'kind'<>'shared' OR x.connection->>'tenant_state'='ready'))
$$;

CREATE FUNCTION send_admission(wid text, actor jsonb, req jsonb, assets jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
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
  outstanding jsonb; capped boolean;
BEGIN
  IF jsonb_typeof(req->'claim')='object' THEN
    previous := idempotency_claim(wid, actor->>'id', req->'claim'->>'path', req->'claim'->>'key', req->'claim'->>'hash', req->'claim'->'receipt');
    IF previous IS NOT NULL THEN RETURN previous; END IF;
    claimed := true;
  END IF;
  <<decide>> BEGIN
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
        h := (SELECT allowance FROM hosted_allowance(wid,CASE WHEN sim THEN 0 ELSE 1 END,0,(req->'caps'->>'firstWeek')::int,(req->'caps'->>'secondWeek')::int,(req->'caps'->>'mature')::int,(req->>'headroom')::numeric));
        IF jsonb_typeof(h)='object' AND billed THEN b := billing_gate(wid,0,sim); END IF;
        IF h->>'pauseReason' IS NOT NULL THEN d := jsonb_build_object('code','HOSTED_SENDING_PAUSED','reason',h->>'pauseReason'); EXIT decide; END IF;
        IF NOT sim AND coalesce((h->>'marketingHeld')::boolean,false) THEN d := jsonb_build_object('code','MARKETING_HELD','reason',h->>'marketingHoldReason'); EXIT decide; END IF;
      END IF;
      IF jsonb_typeof(mails->0->'binding')='object' AND NOT review_binding_ready(wid,mails->0->>'from',mails->0->>'region',mails->0->'binding',sim,req->'platform') THEN
        d := jsonb_build_object('code','SENDER_BINDING_CHANGED'); EXIT decide;
      END IF;
      EXIT decide;
    END IF;

    -- send, launch and prepare.
    IF s.default_region IS NULL THEN d := jsonb_build_object('code','REGION_SETTINGS_NOT_INITIALIZED'); EXIT decide; END IF;
    IF mx AND stage<>'prepare' THEN
      h := (SELECT allowance FROM hosted_allowance(wid,cost,marketing,(req->'caps'->>'firstWeek')::int,(req->'caps'->>'secondWeek')::int,(req->'caps'->>'mature')::int,(req->>'headroom')::numeric));
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
        IF marketing>0 AND coalesce((h->>'marketingHeld')::boolean,false) THEN d := jsonb_build_object('code','MARKETING_HELD','reason',h->>'marketingHoldReason'); EXIT decide; END IF;
        IF h->>'cap' IS NOT NULL THEN
          used := (h->>'used')::bigint;
          reserved := marketing>0 AND marketing+used>(h->>'marketingCap')::bigint;
          hour_cap := (h->>'marketingHourCap')::int;
          IF reserved AND hour_cap IS NOT NULL AND coalesce((h->>'marketingHourUsed')::int,0)+marketing>hour_cap AND cost+used<=(h->>'cap')::bigint THEN
            d := jsonb_build_object('code','SEND_LIMIT_REACHED','window','hour','allowance',h,'incoming',cost,'marketing',marketing); EXIT decide;
          END IF;
          IF cost>0 AND (cost+used>(h->>'cap')::bigint OR reserved) THEN
            d := jsonb_build_object('code','SEND_LIMIT_REACHED','window','day','reserved',reserved,'allowance',h,'incoming',cost,'marketing',marketing); EXIT decide;
          END IF;
        END IF;
      END IF;
      -- Outstanding direct mail: the override or the Hosted default, otherwise a day of the account's own SES quota.
      SELECT p.projected INTO projected FROM direct_pending_load(wid,jsonb_array_length(mails),
        jsonb_array_length(jsonb_path_query_array(mails,'$[*] ? (@.kind == "marketing")'))) p;
      IF jsonb_typeof(h)='object' THEN
        cap := coalesce((h->>'pendingCapOverride')::int,CASE WHEN (h->>'exemptHostedQuotas')::boolean THEN (lim->>'pendingCeiling')::int ELSE (lim->>'pendingFloor')::int END);
      ELSE
        quota := CASE WHEN mx THEN (SELECT max(l.max_24_hour_send) FROM regional_workspace_limits l WHERE l.workspace_id=wid
            AND EXISTS (SELECT FROM provider_connections pc WHERE pc.workspace_id=wid AND pc.kind='byo'))
          ELSE (SELECT max(max_24_hour_send) FROM sending_region_limits WHERE workspace_id=wid) END;
        cap := least((lim->>'pendingCeiling')::int,greatest((lim->>'pendingFloor')::int,floor(coalesce(quota,0))::int));
      END IF;
      IF projected>cap THEN d := jsonb_build_object('code','PENDING_EMAIL_LIMIT_EXCEEDED','cap',cap); EXIT decide; END IF;
    END IF;

    FOR m IN SELECT * FROM jsonb_array_elements(mails) LOOP
      i := i+1; host := lower(m->>'host');
      needs_dmarc := m->>'kind'='marketing' OR (stage='send' AND cost>0 AND coalesce((h->>'used')::bigint,0)+cost>=(lim->>'bulkVolume')::int);
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
        IF coalesce((h->>'marketingHeld')::boolean,false) THEN d := jsonb_build_object('code','MARKETING_HELD','reason',h->>'marketingHoldReason'); EXIT decide; END IF;
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
