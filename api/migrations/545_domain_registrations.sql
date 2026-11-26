-- When each registrable domain a workspace sends from or links on was registered, from its registry's public RDAP record
-- (src/domain-age.ts). Read by the send review to tell a domain new to the internet from one only new here. One row per
-- registrable domain, no workspace: registration dates are public. unknown: the registry gave none (retried a day later).
SET LOCAL lock_timeout = '2s';
CREATE TABLE IF NOT EXISTS domain_registrations (
  root text PRIMARY KEY,
  registered_at timestamptz,
  status text NOT NULL CHECK (status IN ('known', 'unknown')),
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS domain_registrations_checked ON domain_registrations (checked_at);
