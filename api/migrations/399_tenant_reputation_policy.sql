-- The AWS reputation policy Nightmail last applied to each Hosted workspace tenant (src/tenant-policy.ts): strict while
-- the workspace is on probation, standard once it has graduated or an operator exempted it. One row per regional tenant,
-- keyed like hosted_tenant_ownership because the tenant outlives a disconnect.
-- - applied: strict or standard; NULL when unknown (an AWS call whose outcome was lost), which the next pass re-applies.
-- - demoted_at: the last move from standard back to strict. A graduated workspace returns to standard a day later.
-- - refused_at: the last time AWS refused standard (the runtime IAM policy or its boundary does not allow it yet). The
--   tenant stays strict and the reconcile asks again an hour later.
-- A new table: nothing existing is locked or changed.
SET LOCAL lock_timeout='2s';
CREATE TABLE hosted_tenant_policy (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  region text NOT NULL,
  applied text CHECK (applied IN ('strict','standard')),
  applied_at timestamptz,
  demoted_at timestamptz,
  refused_at timestamptz,
  PRIMARY KEY (workspace_id, region));
-- Every ready tenant so far was set strict when it was provisioned (src/ses-setup.ts provisionTenant, since the first
-- shared connection), so the first reconcile calls AWS only for exempt and graduated workspaces.
INSERT INTO hosted_tenant_policy(workspace_id,region,applied,applied_at)
SELECT DISTINCT c.workspace_id,r.region,'strict',now() FROM provider_connections c JOIN provider_connection_regions r ON r.connection_id=c.id
WHERE c.kind='shared' AND r.tenant_state='ready'
ON CONFLICT DO NOTHING;
