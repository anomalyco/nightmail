SET LOCAL lock_timeout='2s';
-- Mentions of the operator on urgent Slack cards (src/operator-mention.ts): one row per card, decided once, so every
-- retry of a card posts it the same way. mentioned: it mentions; capped: it counts against the hourly ceiling; over:
-- it was over the ceiling and posted unmentioned, until told_by names the mentioned card that said so (skipped: how
-- many that card told). Rows older than two days are deleted as new ones are decided.
CREATE TABLE IF NOT EXISTS operator_mentions (
  card text PRIMARY KEY,
  kind text NOT NULL,
  subject text NOT NULL,
  capped boolean NOT NULL,
  mentioned boolean NOT NULL,
  over boolean NOT NULL DEFAULT false,
  told_by text,
  skipped integer NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operator_mentions_at ON operator_mentions (at);
-- The last state of Amazon's account status for a region that the Amazon account card told (operator-alerts.ts
-- amazonAccountAlert): a read that failed never changes it. Expand-only.
ALTER TABLE deliverability_checks ADD COLUMN IF NOT EXISTS told text;
