-- Independent of health_state. Elect before calling CloudWatch; never hold a transaction across the network.
CREATE TABLE ses_quota_samples (
  account text NOT NULL, region text NOT NULL, PRIMARY KEY (account, region),
  attempted_at timestamptz NOT NULL, finished_at timestamptz,
  latest jsonb NOT NULL DEFAULT '{}', last_good jsonb NOT NULL DEFAULT '{}',
  logged_day date
);
