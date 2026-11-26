-- First-party delivery history (src/delivery-history.ts): what each workspace's own mail did, kept past the 30 days the
-- sent-mail log keeps it, for the workspace's own audience review. Written only by the hourly rollup from finished mail;
-- the send path and feedback handling neither read nor write any of it.
SET LOCAL lock_timeout = '2s';
-- Per contact: the campaign and marketing mail SES accepted for it and delivered to it, when the first and the last went,
-- and the soft failures (deferred, never delivered) since its last delivery. Constant defaults: metadata only, no rewrite.
ALTER TABLE audience_contacts ADD COLUMN IF NOT EXISTS mailed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivered_count integer NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS first_mailed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_mailed_at timestamptz, ADD COLUMN IF NOT EXISTS soft_failures smallint NOT NULL DEFAULT 0;
-- Per workspace and recipient domain: every message to one recipient there, by outcome, and the messages that failed by
-- class (src/delivery-history.ts bounceClass). failed_since_delivery counts permanent failures since the last delivery
-- there: a domain that died keeps climbing however long it lived before. Kept 180 days after the last message.
CREATE TABLE IF NOT EXISTS delivery_domain_stats (
  workspace_id text NOT NULL,
  domain text NOT NULL,
  sent bigint NOT NULL DEFAULT 0,
  delivered bigint NOT NULL DEFAULT 0,
  hard_bounced bigint NOT NULL DEFAULT 0,
  soft_failed bigint NOT NULL DEFAULT 0,
  complained bigint NOT NULL DEFAULT 0,
  opened bigint NOT NULL DEFAULT 0,
  clicked bigint NOT NULL DEFAULT 0,
  user_unknown bigint NOT NULL DEFAULT 0,
  dead_domain bigint NOT NULL DEFAULT 0,
  mailbox_full bigint NOT NULL DEFAULT 0,
  blocklist bigint NOT NULL DEFAULT 0,
  policy bigint NOT NULL DEFAULT 0,
  reputation bigint NOT NULL DEFAULT 0,
  auth bigint NOT NULL DEFAULT 0,
  validation bigint NOT NULL DEFAULT 0,
  other bigint NOT NULL DEFAULT 0,
  failed_since_delivery integer NOT NULL DEFAULT 0,
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  last_delivered timestamptz,
  PRIMARY KEY (workspace_id, domain)
);
CREATE INDEX IF NOT EXISTS delivery_domain_stats_seen ON delivery_domain_stats (last_seen);
-- Blocklist rejections and deferrals (a reply naming a blocklist), by the day the mail was sent, the workspace, its From
-- domain, the host of its links (its unsubscribe link's; '' without one) and the blocklist named.
CREATE TABLE IF NOT EXISTS delivery_blocklist_daily (
  workspace_id text NOT NULL,
  day date NOT NULL,
  from_domain text NOT NULL,
  link_host text NOT NULL DEFAULT '',
  list text NOT NULL,
  rejections integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day, from_domain, link_host, list)
);
CREATE INDEX IF NOT EXISTS delivery_blocklist_daily_day ON delivery_blocklist_daily (day);
-- The rollup's lease and its cursor over finished mail (created_at, id).
CREATE TABLE IF NOT EXISTS delivery_history_state (
  id text PRIMARY KEY,
  cursor_at timestamptz,
  cursor_id text,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
