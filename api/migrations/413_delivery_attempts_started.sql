SET LOCAL lock_timeout='2s';
-- Attempts the delivery gate let through for a plain event subscription, including ones whose outcome was
-- never recorded (a runner lost mid-request). Such a delivery has no mail_action_attempts row, so unpausing
-- its webhook resumed it from attempt_count alone and a lost attempt got its retries back.
ALTER TABLE mailbox_webhook_deliveries ADD COLUMN attempts_started integer NOT NULL DEFAULT 0;
