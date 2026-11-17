SET LOCAL lock_timeout='2s';
-- Receiving hosts, part 1 of 2. A domain receives on any set of hosts at once: its root and any of its subdomains, each
-- one mailbox_domains row of the domain (the row the domain always had, or a row whose parent_id is that row) with its
-- own state, MX record, catch-all and addresses. A host's state is its row's status (waiting_for_mx, provisioning,
-- active, disabled once removed) and these two columns, which the claim used to hold for its single host:
--   lost_since  when a routing host's MX went missing (it keeps routing for the two-hour grace);
--   issue       the last DNS issue found there (CNAME, another provider's MX, another claim's host ...).
-- Expand only: the Worker this release replaces never reads them. A row it writes meanwhile leaves them NULL, which
-- reads as "no grace running, no issue" until the next check.
ALTER TABLE mailbox_domains ADD COLUMN IF NOT EXISTS lost_since timestamptz, ADD COLUMN IF NOT EXISTS issue jsonb;

-- Part 2 makes a routing host unique across every workspace (one address never routes twice). Rows that route today
-- mirror their claim, whose host domain_claims_receiving_host already keeps unique, so this finds nothing unless a row
-- outlived its claim's host. Such a row goes back to waiting for its MX; the one its claim routes keeps the host.
WITH ranked AS (
  SELECT m.id,row_number() OVER (PARTITION BY m.receiving_host ORDER BY EXISTS (SELECT FROM operation_domains d
      JOIN domain_claims dc ON dc.workspace_id=d.workspace_id AND dc.name=d.name AND dc.receiving_host=m.receiving_host
      WHERE d.id=m.domain_id AND d.workspace_id=m.workspace_id) DESC,m.status='active' DESC,m.created_at,m.id) AS n
  FROM mailbox_domains m WHERE m.status IN ('active','provisioning') AND m.receiving_host IN (
    SELECT receiving_host FROM mailbox_domains WHERE receiving_host IS NOT NULL AND status IN ('active','provisioning') GROUP BY 1 HAVING count(*)>1)
)
UPDATE mailbox_domains m SET status='waiting_for_mx',updated_at=now() FROM ranked r WHERE r.n>1 AND m.id=r.id;
