-- bane:no-transaction
-- Unsubscribing people per day: the sender score (src/standing.ts) and the deliverability chart (src/deliverability.ts)
-- count distinct contacts since topics, so one person who leaves a topic and then everything is one unsubscribe. This
-- partial index carries contact_id beside the source, so that count stays an index-only scan as the count of rows was.
-- It replaces audience_consent_unsub_occurred (migration 455), which covers the same rows without the contact; built first,
-- so the queries always have one of the two. Imports insert only status = 'subscribed' rows: no write cost for them.
CREATE INDEX CONCURRENTLY IF NOT EXISTS audience_consent_unsub_people ON audience_consent_audit(workspace_id, occurred_at) INCLUDE (source, contact_id) WHERE status = 'unsubscribed';
DROP INDEX CONCURRENTLY IF EXISTS audience_consent_unsub_occurred;
