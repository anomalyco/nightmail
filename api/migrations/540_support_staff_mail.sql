SET LOCAL lock_timeout = '2s';
-- One path to a human (src/support-staff-mail.ts): every support case that needs a person has a ticket and one email
-- thread to staff. A thread is one conversation, one workspace's burst of agent feedback, or one email to a support
-- address that never became a conversation. Its emails are written here, frozen, and sent by the support platform
-- (from the support address to the team, through the binding), which reports each one sent.
CREATE TABLE IF NOT EXISTS support_staff_threads (
  key text PRIMARY KEY CHECK (key ~ '^(conv|feedback|mail):[A-Za-z0-9_:.-]{1,200}$'),
  subject text NOT NULL,
  workspace_id text,
  -- A thread of mail nobody answered: the received thread, its sender (one such thread a sender a day), and the ticket
  -- it was given (a conversation's ticket is the conversation's own).
  mail_thread_id text UNIQUE, sender text, ticket_id text,
  -- The email thread to staff, once its first email is sent, and the last email sent in it (updates reply to it).
  thread_id text, last_message_id text,
  opened_at timestamptz NOT NULL DEFAULT now(), last_sent_at timestamptz
);
CREATE TABLE IF NOT EXISTS support_staff_emails (
  key text PRIMARY KEY,
  thread_key text NOT NULL REFERENCES support_staff_threads(key) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq > 0),
  subject text NOT NULL, text text NOT NULL, html text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, message_id text,
  UNIQUE (thread_key, seq)
);
CREATE INDEX IF NOT EXISTS support_staff_emails_unsent ON support_staff_emails (created_at) WHERE sent_at IS NULL;
-- The thread a conversation is in, and what its last email covered: the conversation's messages up to staff_seq and
-- the Needs you reasons it named.
ALTER TABLE support_conversations ADD COLUMN IF NOT EXISTS staff_thread text REFERENCES support_staff_threads(key) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS staff_seq integer NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS staff_reasons text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS support_conversations_staff_thread ON support_conversations (staff_thread) WHERE staff_thread IS NOT NULL;
-- A decision staff approve with one click (src/support-approvals.ts): proposed by Nightmail's staff email or, later, by
-- the agent for a risky action; it runs only when an operator, signed in, confirms it in the dashboard.
CREATE TABLE IF NOT EXISTS support_approvals (
  id text PRIMARY KEY CHECK (id ~ '^apr_[a-z2-7]{26}$'),
  conversation_id text NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{1,40}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  proposed_by text NOT NULL CHECK (proposed_by IN ('nightmail', 'agent')),
  reason text NOT NULL CHECK (length(reason) <= 400),
  state text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'approved', 'declined', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  decided_by text, decided_at timestamptz, result jsonb
);
CREATE INDEX IF NOT EXISTS support_approvals_open ON support_approvals (conversation_id, kind) WHERE state = 'proposed';
