SET LOCAL lock_timeout='2s';
-- A deleted domain's link host keeps answering the links in mail the domain already sent (src/link-domains.ts
-- forgetLinkHost, cleanUpLinkHosts): an active one becomes 'retired' (retired_at: when), its row and custom hostname kept
-- for LINK_RETENTION_DAYS (src/link-hosts.ts), during which servesWorkspace still serves its workspace's links there and no
-- mail links on it. The cleanup removes it after that.
ALTER TABLE link_hosts DROP CONSTRAINT link_hosts_status_check,
  ADD CONSTRAINT link_hosts_status_check CHECK (status IN ('pending', 'active', 'retired')),
  ADD COLUMN retired_at timestamptz,
  ADD CONSTRAINT link_hosts_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL));

-- The shared fallback host's daily cap per workspace and UTC day, whatever the host (src/link-domains.ts reserveFallback):
-- link_fallback_days counts per host, so a host changed mid-day would have started a second allowance. Seeded with today's
-- and earlier days' totals.
CREATE TABLE link_fallback_totals (
  workspace_id text NOT NULL,
  day date NOT NULL,
  recipients int NOT NULL CHECK (recipients >= 0),
  PRIMARY KEY (workspace_id, day)
);
INSERT INTO link_fallback_totals(workspace_id, day, recipients) SELECT workspace_id, day, sum(recipients) FROM link_fallback_days GROUP BY workspace_id, day;
