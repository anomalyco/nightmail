SET LOCAL lock_timeout = '2s';
-- The other sources of Glass's Deliverability board (src/glass-deliverability.ts refreshDeliverabilitySources):
-- deliverability_vdm_daily: Virtual Deliverability Manager's daily figures per region, ISP (as Amazon names it; '' is
--   every ISP) and metric (SEND, DELIVERY, PERMANENT_BOUNCE, TRANSIENT_BOUNCE, COMPLAINT, DELIVERY_COMPLAINT, OPEN,
--   DELIVERY_OPEN, CLICK, DELIVERY_CLICK), read hourly with BatchGetMetricData. Amazon's estimates, not counts of this
--   installation's mail.
-- deliverability_checks: the latest check of each source by kind and subject (ses: a pool region's GetAccount health,
--   every 10 minutes; vdm: a region's VDM read; dbl: one of the platform's domains on Spamhaus DBL), with next_at as the
--   election of the one process that runs the next.
CREATE TABLE deliverability_vdm_daily (
  region text NOT NULL, day date NOT NULL, isp text NOT NULL, metric text NOT NULL, value double precision NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (region, day, isp, metric)
);
CREATE TABLE deliverability_checks (
  kind text NOT NULL CHECK (kind IN ('ses', 'vdm', 'dbl')), subject text NOT NULL,
  status text, detail jsonb, checked_at timestamptz, next_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, subject)
);
