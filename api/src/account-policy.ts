import { sql, type SQL } from 'drizzle-orm';
import { METHOD_ACR } from './config.js';
import type { Config } from './core.js';

// Who may sign up, decided by the sign-in itself and never by an email address: Anomaly account can assert a
// verified address that the method used to sign in never vouched for (a GitHub-made account that later links a
// personal Google account signs in with acr=google and its GitHub-verified work address).
//
// Anomaly account's claim for the provider identity behind this sign-in: {provider, sub, email, email_verified, hd?}
// from the provider used for this sign-in, omitted when there is none. Requested as an essential ID-token claim.
export const PROVIDER_IDENTITY_CLAIM = 'https://account.anoma.ly/claims/upstream';

export type ProviderIdentity = { provider: string; sub: string; email: string | null; emailVerified: boolean; hd: string | null };

/** The provider identity behind this sign-in, from a verified ID token or a subject-checked UserInfo response. */
export function providerIdentity(source: Record<string, unknown> | null | undefined): ProviderIdentity | null {
  const value = source?.[PROVIDER_IDENTITY_CLAIM];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.provider !== 'string' || typeof p.sub !== 'string' || !p.provider || !p.sub) return null;
  return { provider: p.provider, sub: p.sub, email: typeof p.email === 'string' ? p.email : null, emailVerified: p.email_verified === true,
    hd: typeof p.hd === 'string' && p.hd ? p.hd : null };
}

const methodNames: Record<string, string> = { [METHOD_ACR.github]: 'GitHub', [METHOD_ACR.google]: 'Google', [METHOD_ACR.email]: 'email link', [METHOD_ACR.password]: 'password' };
/** The accepted sign-in methods by name ("GitHub or Google"); null when one isn't the account service's. */
export function acceptedMethods(acr: readonly string[] | undefined) {
  if (!acr?.length || !acr.every(value => methodNames[value])) return null;
  const names = Object.keys(methodNames).filter(value => acr.includes(value)).map(value => methodNames[value]!);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0]!;
}

/** Hosted staff, exactly as the account service defines it: a Google sign-in whose Google account has a verified
 * address and belongs to a staff Google Workspace domain (hd, compared exactly). Only Google proves Workspace
 * membership: a GitHub sign-in is never staff, whatever its address. */
export function isStaffSignIn(config: Pick<Config, 'multiTenant' | 'staffGoogleDomains'>, acr: unknown, upstream: ProviderIdentity | null) {
  return config.multiTenant && acr === METHOD_ACR.google
    && upstream?.provider === 'google' && upstream.emailVerified === true && !!upstream.hd && config.staffGoogleDomains.includes(upstream.hd);
}

const googleMail = new Set(['gmail.com', 'googlemail.com']);
/** The address whose mailbox this sign-in proves the person reads now, for what is bound to an address (an invitation,
 * an emailed support request): an emailed link or code's, which the account service sends only to the account's
 * verified address, the one its token asserts (`verifiedEmail`), at any provider; or a Google sign-in's own verified
 * address when Google hosts that mailbox (a Workspace account, or Gmail). GitHub, a password, or a Google account on
 * another provider's address shows only that an address was verified once. */
export function provenMailbox(acr: unknown, upstream: ProviderIdentity | null, verifiedEmail: string | null) {
  if (acr === METHOD_ACR.email) return verifiedEmail?.toLowerCase() ?? null;
  if (acr !== METHOD_ACR.google || upstream?.provider !== 'google' || !upstream.emailVerified || !upstream.email) return null;
  const email = upstream.email.toLowerCase();
  return upstream.hd || googleMail.has(email.slice(email.lastIndexOf('@') + 1)) ? email : null;
}

/** The GitHub account's own verified address, for a GitHub sign-in only: the account service puts it in the provider
 * identity claim only when GitHub's `GET /user/emails` (its GitHub App's email-read permission, nothing more) lists it
 * as the primary address and verified. Never the account's asserted `email` claim, which another method may have
 * verified. It shows GitHub verified the address, not that its person reads the mailbox now: it takes a sign-up place for
 * that address, one per address (signups.ts takePlace), and admits nothing else bound to an address. */
export function githubVerifiedAddress(acr: unknown, upstream: ProviderIdentity | null) {
  return acr === METHOD_ACR.github && upstream?.provider === 'github' && upstream.emailVerified && upstream.email ? upstream.email.toLowerCase() : null;
}

/** How long a sign-in's proof of the mailbox (provenMailbox) lets email speak for the account. */
export const MAILBOX_PROOF_DAYS = 7;
/**
 * Whether the account row `u` (nightmail_users) has an address its person proved, signed in, to be a mailbox they read:
 * a sign-in whose provenMailbox was that address (recorded at sign-in, account-login.ts) within MAILBOX_PROOF_DAYS, and the
 * address still the account's verified email. The one definition for everything email support decides from an address:
 * binding an email's sender by DMARC, a signed-in claim of one email, and the release of an answer written from the account.
 */
export const mailboxProven = (u: SQL) => sql`(${u}.email_verified AND ${u}.mailbox_proved_at > now() - make_interval(days => ${MAILBOX_PROOF_DAYS}::int)
  AND lower(${u}.mailbox_proved) = lower(${u}.email))`;
