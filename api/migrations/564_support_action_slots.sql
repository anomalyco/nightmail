SET LOCAL lock_timeout = '2s';
-- The support agent's safe actions (src/support-actions.ts: re-checking a domain's or receiving host's DNS, resending a
-- forward confirmation) take turns per target: one row per action kind and target, holding when it last ran. Taking a
-- turn is one upsert that succeeds only once the action's window has passed, in the transaction of the action itself,
-- so one that fails gives its turn back. The hourly retention deletes rows a day old.
CREATE TABLE support_action_slots (
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{1,40}$'),
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 200),
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, target)
);
CREATE INDEX support_action_slots_at ON support_action_slots (at);
