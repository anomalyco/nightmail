-- bane:no-transaction
-- Receiving hosts, part 2 of 2: a host routes (or waits for its bring-your-own receipt rule) for one domain only, across
-- every workspace. Built online; part 1 released any legacy duplicate. Replaces domain_claims_receiving_host, which keeps
-- only the claim's one host unique, once the claim's receiving_host column is dropped in a later release.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS mailbox_domains_routing_host ON mailbox_domains(receiving_host) WHERE receiving_host IS NOT NULL AND status IN ('active','provisioning');
