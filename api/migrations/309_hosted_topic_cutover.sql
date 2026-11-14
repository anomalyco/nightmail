-- Operator-created intents for parallel topics. Only a verified SNS confirmation can
-- fill the proof; this table never authorizes notifications, BYO topics, or sends.
CREATE TABLE hosted_topic_cutover (
  topic_arn text PRIMARY KEY, account_id text NOT NULL, region text NOT NULL,
  endpoint text NOT NULL, expires_at timestamptz NOT NULL,
  confirmed_at timestamptz, confirmation_id text
);
