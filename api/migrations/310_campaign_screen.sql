SET LOCAL lock_timeout='2s';
-- A Hosted campaign is screened once, not once per recipient (src/sending.ts screenCampaignStep): the verdict on the
-- review's own copy and its distinct personalization values, bound to the review's content hash. A review is
-- immutable, so an edited campaign is a new review and is screened again.
ALTER TABLE sending_campaign_reviews ADD COLUMN screen jsonb;
