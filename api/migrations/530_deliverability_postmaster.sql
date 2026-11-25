SET LOCAL lock_timeout = '2s';
-- Gmail Postmaster Tools on Glass's Deliverability board (src/glass-deliverability.ts): Google's daily view of each of the
-- platform's domains, read every 6 hours through the Postmaster Tools API with the OAuth grant in
-- NIGHTMAIL_POSTMASTER_CREDENTIALS (scripts/postmaster-auth.ts makes it). Per domain and day: Gmail's domain reputation
-- (HIGH, MEDIUM, LOW, BAD), the share of mail its users reported as spam (Gmail's complaints: it sends no feedback loop),
-- SPF, DKIM and DMARC pass rates, and the delivery errors as Google lists them. Google publishes a day only once the
-- domain sent Gmail enough mail that day, a day or two late. deliverability_checks gains the kind 'postmaster'.
ALTER TABLE deliverability_checks DROP CONSTRAINT deliverability_checks_kind_check,
  ADD CONSTRAINT deliverability_checks_kind_check CHECK (kind IN ('ses', 'vdm', 'dbl', 'postmaster'));
CREATE TABLE deliverability_postmaster_daily (
  domain text NOT NULL, day date NOT NULL, reputation text, spam_ratio double precision,
  spf_ratio double precision, dkim_ratio double precision, dmarc_ratio double precision, delivery_errors jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, day)
);
