-- The AWS reputation policy Nightmail last applied to each Hosted workspace tenant (src/tenant-policy.ts): strict while
-- the workspace is on probation, paused or under a resume's reduced limit; standard once it has graduated or an operator
-- exempted it. One row per regional tenant, keyed like hosted_tenant_ownership because the tenant outlives a disconnect.
-- - applied: strict or standard; NULL while unknown: the job writes it before each AWS call (so a lost answer or a stopped
--   Worker leaves it), and provisioning over a standard or unknown record. NULL always differs from the level, so the
--   next pass calls AWS and settles it.
-- - demoted_at: the last move to strict from standard or from an unknown outcome. A graduated workspace returns to
--   standard a day later.
-- - refused_at: the last time AWS refused standard (the runtime IAM policy or its boundary does not allow it yet). The
--   tenant stays strict and the reconcile asks again an hour later.
-- A new table. Its foreign key takes a short lock on workspaces: a write held open on that table for more than 2 seconds
-- stops this migration with a lock timeout before anything changes, and the deploy with it. Run it again.
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
