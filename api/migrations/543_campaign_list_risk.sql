-- The list-risk measure a launch records on its review (src/list-risk.ts): its shares, counts and, with the private
-- setting, its band. Nullable: metadata only.
SET LOCAL lock_timeout = '2s';
ALTER TABLE sending_campaign_reviews ADD COLUMN IF NOT EXISTS list_risk jsonb;
