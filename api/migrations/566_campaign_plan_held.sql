-- A plan held on the same daily batch after a day that wasn't healthy (src/send-guards.ts planWindowHealthy): since when,
-- which batch, and why, for the campaign's sender. Null while the plan grows. Nullable: metadata only.
SET LOCAL lock_timeout = '2s';
ALTER TABLE sending_campaigns ADD COLUMN IF NOT EXISTS plan_held jsonb;
