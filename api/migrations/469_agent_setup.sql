SET LOCAL lock_timeout='2s';
-- Agent setup (src/agent-setup.ts): how a coding agent gets its own lasting API key without a person making one by hand.
-- prompt: a signed-in owner or admin copies the agent prompt, which carries a one-time setup token bound to them and
-- their workspace. device: an agent started without the prompt asks for a code (RFC 8628) that a signed-in owner or
-- admin approves at /connect, choosing the workspace. Either way the agent exchanges its secret once for an API key.
-- The secret is the row's ID and a verifier; only the verifier's SHA-256 is kept. Rows are removed a day after they
-- expire (maintenance.ts); the key they made stays, as any key does, until it is revoked.
CREATE TABLE agent_setups (
  id text PRIMARY KEY CHECK (id ~ '^ags_[0-9a-f]{32}$'),
  kind text NOT NULL CHECK (kind IN ('prompt', 'device')),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  -- device: the code the person types at /connect, eight letters without the hyphen it is shown with.
  user_code text UNIQUE CHECK (user_code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{8}$'),
  -- device: what the agent says it is, as one short line (shown as the agent's claim, never trusted).
  client_name text CHECK (length(client_name) <= 100),
  -- prompt: set when the token is made. device: set when it is approved (or, for user_id, denied).
  workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text REFERENCES nightmail_users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'replaced', 'used')),
  key_id text,
  -- device: the seconds an agent waits between polls; slow_down adds five (RFC 8628 §3.5).
  poll_interval integer NOT NULL DEFAULT 5 CHECK (poll_interval BETWEEN 1 AND 120),
  last_polled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  used_at timestamptz,
  CHECK ((kind = 'prompt') = (user_code IS NULL)),
  CHECK (kind = 'device' OR (workspace_id IS NOT NULL AND user_id IS NOT NULL AND status IN ('pending', 'replaced', 'used'))),
  CHECK (status NOT IN ('approved', 'used') OR (workspace_id IS NOT NULL AND user_id IS NOT NULL)),
  CHECK ((status = 'used') = (key_id IS NOT NULL AND used_at IS NOT NULL))
);
-- A new copy replaces the person's earlier unused token in that workspace.
CREATE INDEX agent_setups_pending_prompt ON agent_setups(workspace_id, user_id) WHERE kind = 'prompt' AND status = 'pending';
CREATE INDEX agent_setups_expiry ON agent_setups(expires_at);
-- The key an agent received this way. It manages the workspace like any manage key, except API keys, agent tokens and
-- billing: keyAdminRefusal and agentSetupRefusal (core.ts) refuse those to it, so an agent can't make another API key.
ALTER TABLE api_keys ADD COLUMN agent_setup_id text;
