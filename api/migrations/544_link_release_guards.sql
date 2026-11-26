SET LOCAL lock_timeout='2s';
-- Forwarding and test mail use a zero row to serve a link. Neither starts the warm-up clock.
CREATE INDEX link_fallback_positive_day ON link_fallback_days(host, day) WHERE recipients > 0;
ALTER TABLE deliverability_checks ADD COLUMN held_at timestamptz;
ALTER TABLE sending_campaigns DROP CONSTRAINT sending_campaigns_waiting_reason_check,
  ADD CONSTRAINT sending_campaigns_waiting_reason_check CHECK (
    waiting_reason IN ('pacing_window','ses_daily_quota','hosted_daily_quota','list_probe','balance','feedback_lag','ramp','link_record','link_budget','link_listing')
  ) NOT VALID;
ALTER TABLE sending_campaigns VALIDATE CONSTRAINT sending_campaigns_waiting_reason_check;
