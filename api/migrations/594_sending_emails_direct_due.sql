-- bane:no-transaction
-- The health tick's direct-mail probe (src/health.ts mail-behind): the oldest due email sent through the API, read from
-- the queued head only. Campaign copies have their own probes; delivered mail never enters this index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_emails_direct_due ON sending_emails ((coalesce(scheduled_at, created_at)), id) WHERE status = 'queued' AND campaign_id IS NULL;
