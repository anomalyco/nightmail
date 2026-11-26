-- Recipient domains a campaign stopped releasing to (src/send-guards.ts): its mail there in the last window mostly bounced
-- for good, so the rest of its recipients there are skipped (counted as canceled). One row per campaign and domain, kept
-- 90 days.
SET LOCAL lock_timeout = '2s';
CREATE TABLE IF NOT EXISTS campaign_stopped_domains (
  workspace_id text NOT NULL,
  campaign_id text NOT NULL,
  domain text NOT NULL,
  resolved integer NOT NULL,
  bounced integer NOT NULL,
  stopped_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, domain)
);
CREATE INDEX IF NOT EXISTS campaign_stopped_domains_at ON campaign_stopped_domains (stopped_at);
