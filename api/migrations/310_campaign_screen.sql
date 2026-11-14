SET LOCAL lock_timeout='2s';
-- Hosted campaigns are screened copy by copy, each distinct copy once (src/sending.ts campaignVerdicts). A review keeps
-- its screening state and a budget of classifier requests, charged before each request whether or not it succeeds.
ALTER TABLE sending_campaign_reviews ADD COLUMN screen jsonb, ADD COLUMN screen_budget integer, ADD COLUMN screen_charged integer NOT NULL DEFAULT 0;
-- One verdict per campaign and exact screen input (everything the classifier is sent for a copy), shared by every
-- recipient whose copy reads the same and kept across relaunches of the campaign. `windows` of `requests` are done;
-- an interrupted screen resumes at the next one. judged_at is set when all are.
CREATE TABLE sending_campaign_screens (
  campaign_id text NOT NULL REFERENCES sending_campaigns(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  input_hash text NOT NULL,
  requests integer NOT NULL CHECK (requests > 0),
  windows integer NOT NULL DEFAULT 0,
  spam double precision NOT NULL DEFAULT 0,
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  judged_at timestamptz,
  PRIMARY KEY (campaign_id, input_hash)
);
