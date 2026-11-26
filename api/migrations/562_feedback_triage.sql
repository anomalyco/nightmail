SET LOCAL lock_timeout = '2s';
-- The feedback triage agent (src/feedback-triage.ts): the support platform reads each new agent feedback report once and
-- leaves one note on its ticket. Expand-only: every new column is nullable or defaulted, and only the triage routes
-- write them.
--
-- triage_claimed_at and triage_attempts: the support platform's sweep claims a report before it reads it (at most two
-- attempts, the second only after the first has had 30 minutes), so two sweeps never read the same report at once and a
-- report that fails is not read forever. triage: the note itself (summary, likely cause, suggested classification,
-- duplicates), written once; the same note is a message in the conversation's timeline, and the staff email uses its
-- summary.
ALTER TABLE support_feedback
  ADD COLUMN IF NOT EXISTS triage_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS triage_attempts integer NOT NULL DEFAULT 0 CHECK (triage_attempts >= 0),
  ADD COLUMN IF NOT EXISTS triage jsonb CHECK (triage IS NULL OR jsonb_typeof(triage) = 'object');
-- The reports still to read, oldest first.
CREATE INDEX IF NOT EXISTS support_feedback_untriaged ON support_feedback (created_at) WHERE triage IS NULL;
-- Reports of the same operation from other workspaces: counted, never read.
CREATE INDEX IF NOT EXISTS support_feedback_operation ON support_feedback (operation, created_at) WHERE operation IS NOT NULL;
