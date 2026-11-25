import { sql, type SQLWrapper } from 'drizzle-orm';

// Received mail a key limited to sender domains reads (core.ts domainMailAccess): the SQL both the message reads
// (thread-view.ts visibleLinks, inbound-threads.ts) and the event log (mailbox-events.ts) apply. No imports beyond
// drizzle, so neither pulls in the other.

/** An address's host (after its last @) is one of `domains` or under one, as a sender domain limit reads it. */
export const hostInDomains = (domains: readonly string[], address: SQLWrapper) => sql`(position('@' in ${address}) > 0 AND EXISTS (SELECT FROM unnest(${sql.param([...domains])}::text[]) limit_domain(name)
  WHERE lower(regexp_replace(${address}, '^.*@', '')) = limit_domain.name OR right(lower(regexp_replace(${address}, '^.*@', '')), length(limit_domain.name) + 1) = '.' || limit_domain.name))`;
/**
 * The stored message `message` (an ID column) is addressed to `domains`. A received message needs an SMTP envelope
 * recipient there, so mail a route delivered from another domain, or a mail client copied in, stays hidden even in a
 * mailbox there; a sent one must be from there. Mail sent to both domains is addressed to each, and each reads it.
 */
export const addressedToDomains = (domains: readonly string[], message: SQLWrapper) => sql`EXISTS (SELECT FROM mail_messages addressed WHERE addressed.id = ${message}
  AND CASE WHEN addressed.direction = 'outbound' THEN ${hostInDomains(domains, sql`addressed.from_address`)}
    ELSE EXISTS (SELECT FROM jsonb_array_elements_text(addressed.envelope_to) envelope(recipient) WHERE ${hostInDomains(domains, sql`envelope.recipient`)}) END)`;
/** A column is one of `ids`, as one parameter however many (a domain can have thousands of receiving addresses). */
export const oneOf = (column: SQLWrapper, ids: readonly string[]) => sql`${column} = ANY(${sql.param([...ids])}::text[])`;
