SET LOCAL lock_timeout='2s';
-- What public DNS showed, at the last background check, for a domain still pending an hour after it was added
-- (src/domain-setup.ts): each pending record's state and where the zone is hosted. Domain reads show it, so the dashboard
-- can say which records are missing without asking DNS on every read. Null until the first check.
ALTER TABLE domain_claims ADD COLUMN IF NOT EXISTS setup_check jsonb;
