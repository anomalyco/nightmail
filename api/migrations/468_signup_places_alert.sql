SET LOCAL lock_timeout='2s';
-- The operators' sign-up places alert (src/signups.ts placesAlert): the open places it last told them about, 10 (ten or
-- fewer left) or 0 (full), null while more than ten are open. Each level is posted once; a level isn't posted again
-- until places reopen past it.
ALTER TABLE nightmail_signup_limit ADD COLUMN alerted_open integer CHECK (alerted_open >= 0);
