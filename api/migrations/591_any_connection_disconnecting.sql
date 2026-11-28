SET LOCAL lock_timeout='1s';
-- Every connection can now be 'disconnecting', not only a v5 one: DELETE /v1/connection fences a Hosted or legacy
-- connection in that state while it deletes the connection's SES identities outside any transaction
-- (provider-connections.ts). Widening only, so existing rows need no new check.
ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_state_check,
  ADD CONSTRAINT provider_connections_state_check CHECK (
    state IN ('awaiting_role','provisioning','ready','failed','disconnecting') OR (template_version IS NOT DISTINCT FROM 'v5' AND state IN ('scanning','ready_to_import'))) NOT VALID;
-- 067's mirror, with a disconnecting connection's legacy region disabled, as a v5 disconnect disables its regions.
CREATE OR REPLACE FUNCTION mirror_legacy_connection(c provider_connections) RETURNS void LANGUAGE sql AS $$
  INSERT INTO provider_connection_regions AS r(connection_id,region,legacy,managed_tenant,scan_state,sending_state,tenant_state,feedback_topic_arn,lease_until)
  SELECT c.id,c.region,true,c.managed_tenant,CASE c.state WHEN 'ready' THEN 'ready_to_import' WHEN 'provisioning' THEN 'scanning' ELSE 'awaiting_role' END,
    CASE c.state WHEN 'awaiting_role' THEN 'unprovisioned' WHEN 'disconnecting' THEN 'disabled' ELSE c.state END,c.tenant_state,c.feedback_topic_arn,c.lease_until
  WHERE c.kind='shared' OR c.template_version<>'v5'
  ON CONFLICT(connection_id,region) DO UPDATE SET scan_state=excluded.scan_state,sending_state=excluded.sending_state,
    tenant_state=excluded.tenant_state,feedback_topic_arn=excluded.feedback_topic_arn,lease_until=excluded.lease_until WHERE r.legacy
$$;
