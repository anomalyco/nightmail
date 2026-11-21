-- Support email sign-ins, mailbox proofs and bindings (src/support-conversations.ts, api/README.md "Support integration").
-- Internal: customers never read these rows; they only confirm their own message, signed in.
--
-- A message at a support address that doesn't bind its sender's account (no DMARC pass, an ambiguous From, or an address
-- that matches an account only up to case) gets the fixed reply with a sign-in link for that one message. Registration
-- records it here. The person whose current verified email is the sender's address confirms it signed in
-- (POST /v1/support-conversations/{id}/claim with this message's ID): that binds the conversation to them when nobody is
-- bound yet, and records the sign-in for this message only, also when the conversation is already theirs. The support
-- platform answers exactly the messages its scope lists as signed in, once each.
CREATE TABLE support_email_signins (
  conversation_id text NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  message_id text NOT NULL CHECK (message_id ~ '^msg_[0-9a-f]{32}$'),
  -- The sender's address as registration read it from the stored message (the conversation's one sender).
  address text NOT NULL CHECK (length(address) <= 254),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Who confirmed it, signed in, and when: set once.
  user_id text,
  signed_in_at timestamptz,
  CHECK ((user_id IS NULL) = (signed_in_at IS NULL)),
  PRIMARY KEY (conversation_id, message_id)
);

-- Unsigned sign-ins go after 7 days (src/maintenance.ts), when a claim is refused anyway.
CREATE INDEX support_email_signins_unsigned ON support_email_signins (created_at) WHERE signed_in_at IS NULL;

-- When a sign-in last proved that the person reads the account's address as a mailbox now (account-policy.ts
-- provenMailbox: hosted, a Google-hosted mailbox), and which address it proved. Email support binds an account, and an
-- answer written from it is sent, only within MAILBOX_PROOF_DAYS of such a proof of the address the account has now
-- (account-policy.ts mailboxProven). An address only "verified once" (GitHub, another provider's address) proves nothing.
ALTER TABLE nightmail_users ADD COLUMN mailbox_proved text CHECK (length(mailbox_proved) <= 320), ADD COLUMN mailbox_proved_at timestamptz;

-- Each message that bound an account by email, by its Message-ID: another delivery of the same message (a replay of a
-- signed copy) never binds that account again. Rows go after 7 days (src/maintenance.ts); by then a replay's Date is
-- too old to bind anyway.
CREATE TABLE support_email_bindings (
  user_id text NOT NULL REFERENCES nightmail_users(id) ON DELETE CASCADE,
  rfc_message_id text NOT NULL CHECK (length(rfc_message_id) <= 998),
  message_id text NOT NULL CHECK (message_id ~ '^msg_[0-9a-f]{32}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, rfc_message_id)
);
CREATE INDEX support_email_bindings_created ON support_email_bindings (created_at);
