-- bane:no-transaction
-- Campaign mail leaves the log search trigram index. Each campaign recipient added a trigram set of its addresses,
-- subject and IDs to it, written again on every status change. Mail sent one at a time keeps its substring search:
-- that index is built again for those rows alone, before the old one is dropped, so search always has one. Campaign
-- mail is found by its exact recipient address through the btree below, which also answers the delivered-only release
-- check, or by email ID through the primary key (src/sending.ts sentSearch, deliveredBefore; statistics in 394).
-- Each line builds or drops one index concurrently, so reads and writes go on (src/migrate.ts).
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_emails_direct_log_trgm ON sending_emails USING gin ((CASE WHEN campaign_id IS NULL THEN sending_log_text(id,campaign_id,provider_id,from_address,subject,to_addresses || cc_addresses || bcc_addresses) END) gin_trgm_ops) WHERE campaign_id IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_emails_campaign_recipient ON sending_emails (workspace_id, lower(to_addresses->>0)) WHERE campaign_id IS NOT NULL;
DROP INDEX CONCURRENTLY IF EXISTS sending_emails_log_trgm;
