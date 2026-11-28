import { sql } from 'drizzle-orm';

/**
 * The bits of sending_emails.event_outcomes: every outcome an email's events ever reported, kept even when a
 * higher-ranked status hides it (a hard bounce, then a complaint, leaves status 'complained' with the bounced bit set).
 * Feedback stamps them (src/sending/events.ts, src/sending/claim.ts) and migration 407's tally triggers count them.
 */
export const EMAIL_OUTCOME_BITS = { accepted: 1, delivered: 2, bounced: 4, complained: 8, opened: 16, clicked: 32, failed: 64, delayed: 128 } as const;

// The predicates migration 407 counts with (sending_tally_insert), for sending_emails under `alias` ('' for no alias).
const column = (alias: string, name: string) => sql.raw(alias ? `${alias}.${name}` : name);
const has = (alias: string, bit: number) => sql`(${column(alias, 'event_outcomes')} & ${sql.raw(String(bit))}) <> 0`;
/** Provider acceptance evidence: a provider ID, an accepted-or-later status, or the accepted bit. Suppressed mail is never accepted. Callers leave out simulated mail themselves. */
export const emailAccepted = (alias = 'e') => sql`(${column(alias, 'status')} <> 'suppressed' AND (${column(alias, 'provider_id')} IS NOT NULL OR ${column(alias, 'status')} IN ('accepted','sent','delivered','bounced','complained','delayed') OR ${has(alias, EMAIL_OUTCOME_BITS.accepted)}))`;
export const emailDelivered = (alias = 'e') => sql`(${column(alias, 'status')} = 'delivered' OR ${has(alias, EMAIL_OUTCOME_BITS.delivered)})`;
export const emailBounced = (alias = 'e') => sql`(${column(alias, 'status')} = 'bounced' OR ${has(alias, EMAIL_OUTCOME_BITS.bounced)})`;
export const emailComplained = (alias = 'e') => sql`(${column(alias, 'status')} = 'complained' OR ${has(alias, EMAIL_OUTCOME_BITS.complained)})`;
/** An outcome bit alone (opened, clicked, delayed, ...). */
export const emailHas = (alias: string, outcome: keyof typeof EMAIL_OUTCOME_BITS) => has(alias, EMAIL_OUTCOME_BITS[outcome]);
