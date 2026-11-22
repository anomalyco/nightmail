-- Statistics for the sent-mail search (src/sending.ts sentSearch), ahead of migration 396's index swap. The planner reads
-- an expression's statistics from a whole-table index only, so once the search indexes are partial it needs these to
-- see how rare a search term or an address is; without them it walks the workspace's newest mail instead. The log text
-- is NULL for campaign mail, so a term common in campaign mail alone isn't estimated to match mail sent one at a time.
SET LOCAL lock_timeout = '2s';
CREATE STATISTICS IF NOT EXISTS sending_emails_direct_log_text ON ((CASE WHEN campaign_id IS NULL THEN sending_log_text(id,campaign_id,provider_id,from_address,subject,to_addresses || cc_addresses || bcc_addresses) END)) FROM sending_emails;
CREATE STATISTICS IF NOT EXISTS sending_emails_first_recipient ON (lower(to_addresses->>0)) FROM sending_emails;
ANALYZE sending_emails;
