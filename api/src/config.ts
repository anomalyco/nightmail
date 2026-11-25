import { createPrivateKey, hkdfSync } from 'node:crypto';
import { z } from 'zod';
import { ApiError, log } from './core.js';
import type { Config } from './core.js';
import { envNames, settingNames } from './brand.js';
import { mailServerHosts } from './mail-servers.js';
import { SEND_LIMITS } from './send-limits.js';
import { EVALUATION } from './standing-model.js';

const optional = <T extends z.ZodType>(schema: T) => z.preprocess(v => v === '' ? undefined : v, schema.optional());
const accountId = z.string().regex(/^\d{12}$/);
// The account service's authentication context for each sign-in method it offers: Google and GitHub (its
// acr_values_supported), and its own email sign-ins, an emailed link or code and an email with a password, which it
// reports but doesn't let an app request.
export const METHOD_ACR = { google: 'urn:anomaly:acr:google', github: 'urn:anomaly:acr:github', email: 'urn:anomaly:acr:email', password: 'urn:anomaly:acr:password' } as const;
export const GOOGLE_ACR = METHOD_ACR.google;
const methodAcrs: readonly string[] = Object.values(METHOD_ACR);
const REMOVED_ALLOWLISTS = ['AUTH_ALLOWED_EMAILS', 'AUTH_ALLOWED_DOMAINS']; // Refused at startup when self-hosted, never read. premerge-identity: allowed
const values = z.object({
  NIGHTMAIL_ROOT_SECRET: z.string().min(32),
  MAILGW_API_TOKEN: optional(z.string().min(32)),
  // The domain whose imap. and smtp. hosts reach the mail gateway, as the dashboard shows them (the gateway's TLS
  // certificate names both). Defaults to PUBLIC_URL's host. Shown only while MAILGW_API_TOKEN is set.
  MAILGW_PUBLIC_DOMAIN: optional(z.string().trim().toLowerCase().max(240).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)),
  PREVIOUS_NIGHTMAIL_ROOT_SECRET: optional(z.string().min(32)),
  ACCOUNT_ISSUER: optional(z.url({ protocol: /^https$/ })),
  ACCOUNT_CLIENT_ID: optional(z.string().min(1)),
  ACCOUNT_CLIENT_PRIVATE_KEY: optional(z.string().min(1)),
  ACCOUNT_ID_TOKEN_ALG: z.enum(['ES256', 'RS256']).default('ES256'),
  // The OAuth scopes the MCP server asks for: bane:* until account.anoma.ly supports nightmail:*, then nightmail.
  // Access tokens with either are accepted.
  OAUTH_SCOPE_PREFIX: z.enum(['bane', 'nightmail']).default('bane'),
  // Origins this installation served before PUBLIC_URL and still answers on (https://bane.mx after the switch to
  // nightmail.dev), comma-separated. Their /mcp resource stays valid for tokens minted there. Remove after rename cleanup.
  PREVIOUS_PUBLIC_URLS: z.string().default(''),
  // The name a new v4 BYO connection gives its CloudFormation stack and IAM role (<prefix>-<id>). Regional (v5)
  // connections are always Nightmail-<id>: the broker role may assume only those. Existing connections keep their stack's name.
  BYO_STACK_PREFIX: z.enum(['Bane', 'Nightmail']).default('Bane'),
  // The acr values a sign-in may carry, separated by spaces (one is enough). Kept distinct from a missing value:
  // self-hosted installations opt out with an explicit empty value.
  ACCOUNT_REQUIRED_ACR: z.union([z.literal(''), z.string().max(512).regex(/^\S+(?: \S+)*$/)]).optional(),
  // Self-hosted access: exact issuer subjects (never addresses). Find them with scripts/list-signin-attempts.ts.
  AUTH_ALLOWED_SUBJECTS: z.string().default(''),
  // Self-hosted: subjects that become owners of 'default' at their first sign-in, or * for every allowed subject.
  DEFAULT_WORKSPACE_OWNERS: z.string().trim().default('*'),
  // Hosted staff: Google Workspace domains (the provider identity's hd claim) that may sign up and create workspaces.
  AUTH_STAFF_GOOGLE_DOMAINS: z.string().default(''),
  // Hosted: who may use staff UI notes (src/ui-notes.ts), as "issuer subject" pairs separated by commas. They must also
  // hold the operator role. Empty turns the feature off: its routes answer 404 and the dashboard shows none of it.
  UI_NOTES_SUBJECTS: z.string().default(''),
  // Dashboard usage analytics (docs/analytics.md): first-party, stored in this installation's own bucket. Off by default;
  // off, the dashboard sends nothing and the ingest discards whatever arrives.
  DASHBOARD_ANALYTICS: z.enum(['on', 'off']).default('off'),
  // Hosted: the one email to a domain's owners when its records are still missing an hour after it was added
  // (src/domain-setup.ts). Off by default; the dashboard's banner and the DNS check run either way.
  DOMAIN_SETUP_REMINDER: z.enum(['on', 'off']).default('off'),
  // Hosted: the one email to a new workspace's owners when it still has no domain an hour after sign-up (src/domain-setup.ts).
  // Off by default; the Overview card runs either way.
  NO_DOMAIN_REMINDER: z.enum(['on', 'off']).default('off'),
  ANALYTICS_PUSH_URL: optional(z.url().refine(value => {
    const u = new URL(value); return !u.username && !u.password && !u.hash && (u.protocol === 'https:' || u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname));
  })),
  ANALYTICS_PUSH_SECRET: optional(z.string().min(32).max(256)),
  MULTI_TENANT: z.enum(['true', 'false']).default('false'),
  NIGHTMAIL_PLATFORM_AWS_ACCOUNT: optional(accountId),
  // Hosted only: the one workspace allowed to own PUBLIC_URL's own domain (see scripts/adopt-platform-domain.ts).
  NIGHTMAIL_PLATFORM_DOMAIN_WORKSPACE: optional(z.string().regex(/^ws_[0-9a-f]{32}$/)),
  // Hosted only: From for owner notices about sender standing (warn, restrict, pause, quarantine). Sent through the
  // platform workspace above; unset means notices appear only in the dashboard and the account.standing.changed webhook.
  NIGHTMAIL_NOTIFY_FROM: optional(z.email().max(254)),
  // Hosted only, with the platform workspace above: the shared test sender (src/test-sender.ts), an address of a domain
  // that workspace holds, which a workspace with no verified domain may send from to its members' own addresses (with
  // regional sending; otherwise it is refused as unavailable). Unset: there is no test sender.
  NIGHTMAIL_TEST_SENDER: optional(z.email().max(254)),
  // Hosted only: a list (lst_…) of the platform workspace above that everyone who joins the waitlist or signs up is
  // kept in as a contact, with properties to segment by (src/signups.ts). Unset, or not a list ID: nothing is written.
  NIGHTMAIL_SIGNUPS_LIST_ID: z.unknown().optional(),
  // Hosted only, support integration (api/README.md "Support integration"): where "Contact support" sends a member, and
  // the Ed25519 private JWK (with "x") that signs the handoff it carries. Treat the key as a secret. The support
  // platform itself has no credential here: it calls the SupportPlatform service-binding entrypoint (src/worker.ts).
  NIGHTMAIL_SUPPORT_URL: optional(z.url({ protocol: /^https$/ }).max(500)),
  NIGHTMAIL_SUPPORT_SIGNING_KEY: optional(z.string().max(2000)),
  // Hosted only, not a secret: the inbound address IDs (mbx_…, comma-separated) of the support addresses. Only mail
  // Nightmail received at one of them can open an email support conversation (src/support-conversations.ts).
  NIGHTMAIL_SUPPORT_ADDRESS_IDS: optional(z.string().max(2000)),
  // Hosted only: a support grant's view of its customer's failed requests (GET /v1/support/requests) reads this Worker's
  // request lines from Workers Logs with a Cloudflare API token that can read Workers Observability on the account (a
  // secret), the account ID and this Worker's script name. Unless all three are set, those reads answer available: false.
  CF_OBSERVABILITY_TOKEN: optional(z.string().min(20).max(500)),
  CF_OBSERVABILITY_ACCOUNT_ID: optional(z.string().regex(/^[0-9a-f]{32}$/)),
  CF_OBSERVABILITY_SCRIPT: optional(z.string().regex(/^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/)),
  NIGHTMAIL_REGIONAL_SENDING: z.enum(['true','false']).default('false'),
  NIGHTMAIL_TRUSTED_POOL: z.enum(['true','false']).default('false'),
  NIGHTMAIL_RECEIVING_REDRIVE: z.enum(['true','false']).default('false'),
  // Development installations only: let Hosted pools become ready while the AWS account is still in the SES sandbox.
  NIGHTMAIL_ALLOW_SES_SANDBOX: z.enum(['true','false']).default('false'),
  NIGHTMAIL_REQUIRE_DMARC_FOR_BULK: z.enum(['true','false']).optional(),
  NIGHTMAIL_HOSTED_SCREEN: z.enum(['true','false']).default('true'),
  // Hosted only: abuse monitoring (src/abuse.ts) is off until this names the instant it starts (RFC 3339, with Z or an
  // offset). Nothing is recorded before it, or before the database first ran with it. Unset turns it off; expiry still runs.
  NIGHTMAIL_ABUSE_MONITORING: optional(z.iso.datetime({ offset: true })),
  // Hosted only: a Slack incoming webhook for abuse-monitoring alerts (src/abuse-alerts.ts). Unset, alerts are stored
  // for operators and nothing is posted. Treat as a secret.
  ABUSE_SLACK_WEBHOOK_URL: optional(z.string().url().max(2048).refine(value => value.startsWith('https://hooks.slack.com/'), 'Use a Slack incoming webhook URL.')),
  // Hosted only: a Slack incoming webhook for the operator alerts (src/operator-alerts.ts): a new sign-up, a pause, a
  // marketing hold, the daily limit, a full customer share, slow sign-in mail; and the health alerts (src/health.ts): a
  // queue, the jobs, a campaign, a route or the database falling behind. Unset, nothing is posted. Treat as a secret.
  OPERATOR_SLACK_WEBHOOK_URL: optional(z.string().url().max(2048).refine(value => value.startsWith('https://hooks.slack.com/'), 'Use a Slack incoming webhook URL.')),
  // The commit this deploy runs and when it was deployed (.github/scripts/deploy-worker.sh sets both; Docker may). Glass
  // shows them; a value that isn't a commit or a time is ignored, never an error.
  DEPLOY_SHA: z.unknown().optional(),
  DEPLOY_AT: z.unknown().optional(),
  // The database's disk in GB, optional: the Health page shows the database's size against it (src/health.ts).
  DATABASE_DISK_GB: optional(z.coerce.number().positive().max(1_000_000)),
  // Hosted only, optional: the signing secret of the PlanetScale webhook that reports the database disk (src/disk-alert.ts).
  // Set, a delivery must also carry a matching X-PlanetScale-Signature. Treat as a secret. Its length is checked in
  // loadConfig, not here: an optional secret that is wrong must not stop the installation.
  PLANETSCALE_WEBHOOK_SECRET: optional(z.string()),
  // Hosted only. Reserved for a later release: monitoring only observes, and nothing reads this.
  NIGHTMAIL_ABUSE_ENFORCE: z.enum(['true','false']).default('false'),
  STRIPE_SECRET_KEY: optional(z.string().regex(/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+$/)),
  STRIPE_WEBHOOK_SECRET: optional(z.string().regex(/^whsec_[A-Za-z0-9_]+$/)),
  STRIPE_AUTOMATIC_TAX: z.enum(['true','false']).default('false'),
  // The one Stripe Product every top-up and recharge is for, created on first use with STRIPE_TAX_CODE (api/README.md, Stripe setup).
  STRIPE_CREDIT_PRODUCT_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default('nightmail_credit'),
  STRIPE_TAX_CODE: z.string().regex(/^txcd_\d{8}$/).default('txcd_10103001'),
  STRIPE_API_BASE: z.url().default('https://api.stripe.com'),
  NIGHTMAIL_PLACEMENT_SHADOW: z.enum(['true','false']).default('true'),
  // Licensed DBL-compatible DNS zone (may contain a subscription key). Never log it.
  NIGHTMAIL_PLACEMENT_DBL_ZONE: optional(z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)),
  NIGHTMAIL_BYO_V2: z.enum(['true','false']).default('false'),
  BYO_V5_TEMPLATE_URL: optional(z.url({ protocol: /^https$/ })),
  // The origin a connected account's SNS topics deliver to (https://events.nightmail.dev): its role template allows
  // only this host. Unset, BYO uses SES_FEEDBACK_URL or PUBLIC_URL.
  BYO_EVENTS_ORIGIN: optional(z.url({ protocol: /^https$/ })),
  BYO_TEMPLATE_URL: optional(z.url({ protocol: /^https$/ })),
  DOMAIN_CONNECT_PRIVATE_KEY: optional(z.string().min(1)),
  DOMAIN_CONNECT_KEY_ID: optional(z.string().regex(/^_?[a-z0-9][a-z0-9-]{0,60}[a-z0-9]$/)),
  // Comma-separated regions offered for MX shared sending.
  SHARED_SENDING_REGIONS: z.string().default('us-east-2'),
  // Upgrade-only decryption input for pre-OIDC installations. Never used as the new encryption key.
  ENCRYPTION_KEY: optional(z.string().regex(/^[a-f0-9]{64}$/i)),
  PUBLIC_URL: z.string().url(),
  SES_FEEDBACK_URL: optional(z.string().url().max(2048)),
  DEFAULT_SES_REGION: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/).default('us-east-1'),
  ENABLE_LIVE_SES: z.enum(['true', 'false']).default('false'),
  SIMULATED_SES_LATENCY_MS: z.coerce.number().int().min(0).max(15000).default(100),
  SIMULATED_SES_RATE: z.coerce.number().int().min(1).max(100000).default(1000),
  SIMULATED_SES_DELIVERY_DELAY_MS: z.coerce.number().int().min(0).max(60000).default(250),
  // Aim the dispatcher at a share of the provider quota (1 = exactly the quota). Overshoot is self-correcting:
  // a throttled response drops the target back to the quota for ten seconds.
  DISPATCH_RATE_FACTOR: z.coerce.number().min(0.1).max(10).default(1),
  DISPATCH_TX_RESERVE_PERCENT: z.coerce.number().min(0).max(90).default(15),
  DISPATCH_DAILY_HEADROOM_PERCENT: z.coerce.number().min(0).max(100).default(10),
  // Hosted: the percent of a shared account's daily SES limit all outside (non-exempt) workspaces together may use.
  HOSTED_CUSTOMER_SHARE_PERCENT: z.coerce.number().min(0).max(100).default(50),
  // Absolute live SES target in recipients per second; replaces the quota-derived rate when set.
  DISPATCH_TARGET_RATE: optional(z.coerce.number().int().min(1).max(100000)),
  AWS_ACCESS_KEY_ID: optional(z.string()), AWS_SECRET_ACCESS_KEY: optional(z.string()), AWS_SESSION_TOKEN: optional(z.string()),
  AWS_RUNTIME_CREDENTIALS: z.string().optional(),
  // Requests per minute allowed for each API key, agent token, MCP grant and mailbox key.
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(60).max(100000).default(1200),
  // Slack incoming webhook for hourly SES reputation threshold alerts. Treat as a secret.
  REPUTATION_ALERT_SLACK_URL: optional(z.string().url().max(2048).refine(value => value.startsWith('https://hooks.slack.com/'), 'Use a Slack incoming webhook URL.')),
  // Key for the opt-in Jev content screen on transactional sends (`screen: true`): a TypeSafe AI key, or an
  // OpenCode Console key when JEV_ENDPOINT is OpenCode's inference gateway. Treat as a secret.
  TYPESAFE_API_KEY: optional(z.string().min(1)),
  JEV_ENDPOINT: z.preprocess(v => v === '' ? undefined : v, z.string().url().refine(v => v.startsWith('https://'), 'Use an https URL.').default('https://api.typesafe.ai/v1/systemone')),
  JEV_MODEL: z.preprocess(v => v === '' ? undefined : v, z.string().min(1).max(100).default('jev-latest')),
  JEV_SCREEN_MODE: z.preprocess(v => v === '' ? undefined : v, z.enum(['reject', 'flag']).default('reject')),
  JEV_SCREEN_THRESHOLD: z.preprocess(v => v === '' ? undefined : v, z.coerce.number().min(0).max(1).default(0.7)),
  // Screened-text limits in UTF-8 bytes (src/screen.ts): a message is screened on its own, a campaign once for all its
  // recipients, so a campaign may be longer. Each 8,000-byte classifier request reads at least 4.7 KB of new text
  // (about 7 KB for a message with few link hosts): src/screen.ts chunksFor.
  JEV_MESSAGE_LIMIT_BYTES: z.preprocess(v => v === '' ? undefined : v, z.coerce.number().int().min(4096).max(256 * 1024).default(SEND_LIMITS.screen.messageBytes)),
  JEV_CAMPAIGN_LIMIT_BYTES: z.preprocess(v => v === '' ? undefined : v, z.coerce.number().int().min(4096).max(256 * 1024).default(SEND_LIMITS.screen.campaignBytes)),
  // Second classifier for shadow comparisons and for failover when the primary fails (401/402/403/429/451/5xx/timeouts).
  JEVF_API_KEY: optional(z.string().min(1)),
  JEVF_ENDPOINT: z.preprocess(v => v === '' ? undefined : v, z.string().url().refine(v => v.startsWith('https://'), 'Use an https URL.').default('https://jevf-inference.opencode.ai/v1/systemone')),
  JEVF_MODEL: z.preprocess(v => v === '' ? undefined : v, z.string().min(1).max(100).default('jevf')),
  JEVF_DEADLINE_MS: z.preprocess(v => v === '' ? undefined : v, z.coerce.number().int().min(100).max(30000).default(5000)),
  JEVF_MAX_CONCURRENCY: z.preprocess(v => v === '' ? undefined : v, z.coerce.number().int().min(1).max(64).default(8)),
});
// Each NIGHTMAIL_<x> setting is also read under its earlier names (brand.ts settingNames: BANE_<x>, then MX_<x>), and
// PREVIOUS_NIGHTMAIL_ROOT_SECRET as PREVIOUS_BANE_ROOT_SECRET. The NIGHTMAIL_ name wins. Remove after rename cleanup.
const PREVIOUS = 'PREVIOUS_';
const settingKeys = Object.keys(values.shape).filter(key => key.replace(PREVIOUS, '').startsWith('NIGHTMAIL_'));
const namesOf = (key: string) => key.startsWith(PREVIOUS) ? envNames(key.slice(PREVIOUS.length + 'NIGHTMAIL_'.length)).map(name => PREVIOUS + name) : settingNames(key.slice('NIGHTMAIL_'.length));
export const CONFIG_KEYS = [...new Set([...Object.keys(values.shape), ...settingKeys.flatMap(namesOf)])];
export function migrationSettings(input: Record<string, unknown>) {
  return {workspaceId: 'default', regions: [values.shape.DEFAULT_SES_REGION.parse(input.DEFAULT_SES_REGION)]};
}
export function requirePlatformAccount(account: Config['platformAccount']): string {
  if (!account || !accountId.safeParse(account).success) throw new ApiError(503,'CONFIG_INVALID','Set NIGHTMAIL_PLATFORM_AWS_ACCOUNT to the 12-digit platform AWS account ID.');
  if (account==='438095551154') throw new ApiError(503,'PLATFORM_ACCOUNT_RETIRED','This release cannot use the retired Hosted AWS account. Switch the runtime key and NIGHTMAIL_PLATFORM_AWS_ACCOUNT together.');
  return account;
}
const list = (value: string) => [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))];
let signingSecretIgnored = false;
/**
 * PlanetScale's signing secret, or undefined for one that cannot be it (under 32 or over 200 characters): the disk
 * alert then checks its token alone, as when the secret is unset. Said once per process, never with the value.
 */
function planetscaleSecret(value: string | undefined) {
  if (!value || value.length >= 32 && value.length <= 200) return value;
  if (!signingSecretIgnored) log('warn', { code: 'PLANETSCALE_WEBHOOK_SECRET_IGNORED', message: 'PLANETSCALE_WEBHOOK_SECRET is not 32 to 200 characters, so it is not used: the database disk alert checks its Authorization header alone.' });
  signingSecretIgnored = true;
  return undefined;
}
let signupsListIgnored = false;
/** The sign-ups list, or undefined for a value that isn't a list ID: the optional sync is off, and nothing else is. Said once, never with the value. */
function signupsListId(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'string' && /^lst_[0-9a-f]{32}$/.test(value)) return value;
  if (!signupsListIgnored) log('warn', { code: 'SIGNUPS_LIST_IGNORED', message: 'NIGHTMAIL_SIGNUPS_LIST_ID is not a list ID (lst_ and 32 hex digits), so sign-ups are not kept in a list.' });
  signupsListIgnored = true;
  return undefined;
}
// Separate from Better Auth's signing/encryption uses even though installers manage one root secret.
export function deriveEncryptionKey(secret: string): string {
  return Buffer.from(hkdfSync('sha256', secret, 'opensend:keys:v1', 'webhook-encryption', 32)).toString('hex');
}
export function loadConfig(input: Record<string, unknown>): Config {
  const catalogUnused = input.MULTI_TENANT !== 'true' || !input.STRIPE_SECRET_KEY || !input.STRIPE_WEBHOOK_SECRET;
  const parsed = values.safeParse({...input, ...Object.fromEntries(settingKeys.map(key => [key, namesOf(key).map(name => input[name]).find(value => value !== undefined && value !== null)])),
    ...(catalogUnused ? { STRIPE_CREDIT_PRODUCT_ID: undefined, STRIPE_TAX_CODE: undefined } : {})});
  if (!parsed.success) throw new ApiError(503, 'CONFIG_INVALID', `Missing or invalid server configuration: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}.`);
  const v = parsed.data;
  if (Boolean(v.ANALYTICS_PUSH_URL) !== Boolean(v.ANALYTICS_PUSH_SECRET)) throw new ApiError(503, 'CONFIG_INVALID', 'Set both ANALYTICS_PUSH_URL and ANALYTICS_PUSH_SECRET.');
  if (Boolean(v.ACCOUNT_CLIENT_ID) !== Boolean(v.ACCOUNT_CLIENT_PRIVATE_KEY)) throw new ApiError(503,'CONFIG_INVALID','Set both ACCOUNT_CLIENT_ID and ACCOUNT_CLIENT_PRIVATE_KEY.');
  // Hosted sign-in and MCP accept only the account service's own methods (METHOD_ACR). A missing, empty or misspelled
  // value must stop the installation instead of silently accepting every authentication method.
  const requiredAcr = v.ACCOUNT_REQUIRED_ACR ? [...new Set(v.ACCOUNT_REQUIRED_ACR.split(' '))] : undefined;
  const methodsOnly = !!requiredAcr?.every(acr => methodAcrs.includes(acr));
  if (v.MULTI_TENANT==='true' && !methodsOnly) throw new ApiError(503,'CONFIG_INVALID',`Hosted installations require ACCOUNT_REQUIRED_ACR to list sign-in methods (${methodAcrs.join(', ')}), separated by spaces.`);
  let aws: Config['aws'] = v.AWS_ACCESS_KEY_ID && v.AWS_SECRET_ACCESS_KEY ? { accessKeyId:v.AWS_ACCESS_KEY_ID, secretAccessKey:v.AWS_SECRET_ACCESS_KEY, sessionToken:v.AWS_SESSION_TOKEN } : undefined;
  if (v.AWS_RUNTIME_CREDENTIALS !== undefined) {
    try { aws = z.object({accessKeyId:z.string().min(1), secretAccessKey:z.string().min(1)}).strict().parse(JSON.parse(v.AWS_RUNTIME_CREDENTIALS)); }
    catch { throw new ApiError(503,'CONFIG_INVALID','AWS_RUNTIME_CREDENTIALS must contain a complete runtime key pair.'); }
  }
  if (v.MULTI_TENANT==='true' && v.ENABLE_LIVE_SES==='true' && v.NIGHTMAIL_HOSTED_SCREEN==='true' && !v.TYPESAFE_API_KEY)
    throw new ApiError(503,'CONFIG_INVALID','Hosted live screening requires TYPESAFE_API_KEY.');
  if (v.MULTI_TENANT==='true' && (v.NIGHTMAIL_PLATFORM_AWS_ACCOUNT || [v.NIGHTMAIL_REGIONAL_SENDING,v.NIGHTMAIL_TRUSTED_POOL,v.NIGHTMAIL_BYO_V2].includes('true'))) requirePlatformAccount(v.NIGHTMAIL_PLATFORM_AWS_ACCOUNT);
  if (Boolean(v.DOMAIN_CONNECT_PRIVATE_KEY) !== Boolean(v.DOMAIN_CONNECT_KEY_ID)) throw new ApiError(503,'CONFIG_INVALID','Set both DOMAIN_CONNECT_PRIVATE_KEY and DOMAIN_CONNECT_KEY_ID, or neither.');
  let domainConnect: Config['domainConnect'];
  if (v.DOMAIN_CONNECT_PRIVATE_KEY && v.DOMAIN_CONNECT_KEY_ID) {
    try {
      const privateKey=createPrivateKey(v.DOMAIN_CONNECT_PRIVATE_KEY.replace(/\\n/g,'\n'));
      if (privateKey.asymmetricKeyType!=='rsa' || privateKey.asymmetricKeyDetails?.modulusLength!==2048) throw new Error();
      domainConnect={privateKey,keyId:v.DOMAIN_CONNECT_KEY_ID};
    } catch { throw new ApiError(503,'CONFIG_INVALID','DOMAIN_CONNECT_PRIVATE_KEY must be an RSA-2048 private key in PEM format.'); }
  }
  if (v.PREVIOUS_NIGHTMAIL_ROOT_SECRET && v.ENCRYPTION_KEY) throw new ApiError(503, 'CONFIG_INVALID', 'Finish the legacy ENCRYPTION_KEY upgrade before configuring PREVIOUS_NIGHTMAIL_ROOT_SECRET.');
  // Email allowlists were removed: an issuer can assert a verified address its sign-in method never vouched for.
  // A self-hosted installation that still sets one would silently lose its access policy, so refuse to start.
  if (v.MULTI_TENANT !== 'true' && REMOVED_ALLOWLISTS.some(key => typeof input[key] === 'string' && (input[key] as string).trim()))
    throw new ApiError(503, 'CONFIG_INVALID', `${REMOVED_ALLOWLISTS.join(' and ')} were removed. List issuer subjects in AUTH_ALLOWED_SUBJECTS (scripts/list-signin-attempts.ts shows them).`);
  const allowedSubjects = list(v.AUTH_ALLOWED_SUBJECTS);
  const defaultWorkspaceOwners = v.MULTI_TENANT === 'true' ? [] : v.DEFAULT_WORKSPACE_OWNERS === '*' ? '*' : list(v.DEFAULT_WORKSPACE_OWNERS);
  const staffGoogleDomains = list(v.AUTH_STAFF_GOOGLE_DOMAINS).map(d => d.toLowerCase());
  if (staffGoogleDomains.some(d => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d))) throw new ApiError(503, 'CONFIG_INVALID', 'Use exact Google Workspace domains in AUTH_STAFF_GOOGLE_DOMAINS, without wildcards or URLs.');
  if (staffGoogleDomains.length && !requiredAcr?.includes(GOOGLE_ACR)) throw new ApiError(503, 'CONFIG_INVALID', `AUTH_STAFF_GOOGLE_DOMAINS needs ACCOUNT_REQUIRED_ACR to include ${GOOGLE_ACR}.`);
  const uiNotesSubjects = v.MULTI_TENANT !== 'true' ? [] : list(v.UI_NOTES_SUBJECTS).map(pair => {
    const [issuer, subject, extra] = pair.split(/\s+/);
    if (!issuer || !subject || extra !== undefined || !/^https:\/\/[^/\s]+$/.test(issuer) || subject.length > 255) throw new ApiError(503, 'CONFIG_INVALID', 'UI_NOTES_SUBJECTS lists "https://issuer subject" pairs separated by commas.');
    return { issuer, subject };
  });
  const regions = [v.DEFAULT_SES_REGION];
  const sharedRegions = list(v.SHARED_SENDING_REGIONS);
  if (!sharedRegions.length || sharedRegions.some(r => !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(r))) throw new ApiError(503, 'CONFIG_INVALID', 'Set SHARED_SENDING_REGIONS to comma-separated AWS regions.');
  let supportSigningKey: NonNullable<Config['support']>['signingKey'];
  if (v.NIGHTMAIL_SUPPORT_SIGNING_KEY) {
    const jwk = (() => { try { return JSON.parse(v.NIGHTMAIL_SUPPORT_SIGNING_KEY!) as Record<string, unknown>; } catch { return null; } })();
    if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string' || typeof jwk.x !== 'string') throw new ApiError(503, 'CONFIG_INVALID', 'Set NIGHTMAIL_SUPPORT_SIGNING_KEY to an Ed25519 private JWK with d and x.');
    supportSigningKey = { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x };
  }
  const supportAddressIds = list(v.NIGHTMAIL_SUPPORT_ADDRESS_IDS ?? '');
  if (supportAddressIds.some(id => !/^mbx_[0-9a-f]{32}$/.test(id))) throw new ApiError(503, 'CONFIG_INVALID', 'Set NIGHTMAIL_SUPPORT_ADDRESS_IDS to inbound address IDs (mbx_…) separated by commas.');
  const url = new URL(v.PUBLIC_URL);
  const jevf = v.TYPESAFE_API_KEY && v.JEVF_API_KEY ? { apiKey: v.JEVF_API_KEY, endpoint: v.JEVF_ENDPOINT, model: v.JEVF_MODEL, deadlineMs: v.JEVF_DEADLINE_MS, maxConcurrency: v.JEVF_MAX_CONCURRENCY } : undefined;
  const previousOrigins = list(v.PREVIOUS_PUBLIC_URLS).map(value => { try { const u = new URL(value); if (u.protocol === 'https:' && u.origin !== url.origin) return u.origin; } catch { /* refused below */ } throw new ApiError(503, 'CONFIG_INVALID', 'PREVIOUS_PUBLIC_URLS lists https origins other than PUBLIC_URL, separated by commas.'); });
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new ApiError(503, 'CONFIG_INVALID', 'PUBLIC_URL must use HTTPS, except for localhost development.');
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new ApiError(503, 'CONFIG_INVALID', 'PUBLIC_URL must be a canonical origin without credentials, a path, query or fragment.');
  return {
    // Retained internal storage namespace, not an installation setting or browser-provided tenant ID.
    workspaceId: 'default', multiTenant: v.MULTI_TENANT === 'true', authSecret: v.NIGHTMAIL_ROOT_SECRET, previousAuthSecret: v.PREVIOUS_NIGHTMAIL_ROOT_SECRET,mailGatewayToken:v.MAILGW_API_TOKEN,
    mailServers: v.MAILGW_API_TOKEN ? mailServerHosts(v.MAILGW_PUBLIC_DOMAIN ?? url.hostname) : undefined,
    platformAccount: v.NIGHTMAIL_PLATFORM_AWS_ACCOUNT, platformDomainWorkspace: v.MULTI_TENANT==='true' ? v.NIGHTMAIL_PLATFORM_DOMAIN_WORKSPACE : undefined, notifyFrom: v.MULTI_TENANT==='true' ? v.NIGHTMAIL_NOTIFY_FROM : undefined,
    testSender: v.MULTI_TENANT==='true' && v.NIGHTMAIL_PLATFORM_DOMAIN_WORKSPACE ? v.NIGHTMAIL_TEST_SENDER?.toLowerCase() : undefined,
    signupsListId: v.MULTI_TENANT==='true' ? signupsListId(v.NIGHTMAIL_SIGNUPS_LIST_ID) : undefined,
    support: v.MULTI_TENANT==='true' ? { url: v.NIGHTMAIL_SUPPORT_URL, signingKey: supportSigningKey, addressIds: supportAddressIds } : undefined,
    observability: v.MULTI_TENANT==='true' && v.CF_OBSERVABILITY_TOKEN && v.CF_OBSERVABILITY_ACCOUNT_ID && v.CF_OBSERVABILITY_SCRIPT
      ? { token: v.CF_OBSERVABILITY_TOKEN, accountId: v.CF_OBSERVABILITY_ACCOUNT_ID, script: v.CF_OBSERVABILITY_SCRIPT } : undefined, receivingRedrive:v.NIGHTMAIL_RECEIVING_REDRIVE==='true',byoTemplateUrl: v.BYO_TEMPLATE_URL, sharedRegions, regionalSending: v.MULTI_TENANT === 'true' && v.NIGHTMAIL_REGIONAL_SENDING === 'true',
    trustedPool: v.MULTI_TENANT==='true' && v.NIGHTMAIL_REGIONAL_SENDING==='true' && v.NIGHTMAIL_TRUSTED_POOL==='true',
    allowSesSandbox: v.MULTI_TENANT==='true' && v.NIGHTMAIL_ALLOW_SES_SANDBOX==='true',
    requireDmarcForBulk: v.MULTI_TENANT === 'true' && (v.NIGHTMAIL_REQUIRE_DMARC_FOR_BULK ?? v.ENABLE_LIVE_SES) === 'true',
    hostedScreen: v.MULTI_TENANT==='true' && v.NIGHTMAIL_HOSTED_SCREEN==='true',
    abuseMonitoring: v.MULTI_TENANT==='true' && v.NIGHTMAIL_ABUSE_MONITORING ? { since: new Date(v.NIGHTMAIL_ABUSE_MONITORING).toISOString() } : undefined,
    abuseEnforce: v.MULTI_TENANT==='true' && v.NIGHTMAIL_ABUSE_ENFORCE==='true', abuseSlackWebhookUrl: v.MULTI_TENANT==='true' ? v.ABUSE_SLACK_WEBHOOK_URL : undefined,
    operatorSlackWebhookUrl: v.MULTI_TENANT==='true' ? v.OPERATOR_SLACK_WEBHOOK_URL : undefined,
    databaseDiskBytes: v.DATABASE_DISK_GB === undefined ? undefined : v.DATABASE_DISK_GB * 1024 ** 3,
    deploy: { sha: typeof v.DEPLOY_SHA === 'string' && /^[0-9a-f]{7,40}$/.test(v.DEPLOY_SHA) ? v.DEPLOY_SHA : null,
      at: typeof v.DEPLOY_AT === 'string' && Number.isFinite(Date.parse(v.DEPLOY_AT)) ? new Date(v.DEPLOY_AT).toISOString() : null },
    planetscaleWebhookSecret: v.MULTI_TENANT==='true' ? planetscaleSecret(v.PLANETSCALE_WEBHOOK_SECRET) : undefined,
    billing: v.MULTI_TENANT==='true' ? { stripe: v.STRIPE_SECRET_KEY && v.STRIPE_WEBHOOK_SECRET ? { secretKey: v.STRIPE_SECRET_KEY, webhookSecret: v.STRIPE_WEBHOOK_SECRET, automaticTax: v.STRIPE_AUTOMATIC_TAX === 'true',
      creditProduct: v.STRIPE_CREDIT_PRODUCT_ID, taxCode: v.STRIPE_TAX_CODE, apiBase: v.STRIPE_API_BASE.replace(/\/$/, '') } : undefined } : undefined,
    placementShadow: v.MULTI_TENANT === 'true' && v.NIGHTMAIL_PLACEMENT_SHADOW === 'true', placementDblZone: v.NIGHTMAIL_PLACEMENT_DBL_ZONE,
    byoV2: v.MULTI_TENANT === 'true' && v.NIGHTMAIL_BYO_V2 === 'true', byoV5TemplateUrl: v.BYO_V5_TEMPLATE_URL, byoEventsOrigin: v.BYO_EVENTS_ORIGIN,
    // The daily limit of a workspace the standing job has not seen yet: the evaluation's (docs/sending-limits.md).
    hostedSendCaps: { firstWeek: EVALUATION.limit },
    domainConnect,
    allowedSubjects, staffGoogleDomains, defaultWorkspaceOwners, accountRequiredAcr: requiredAcr, uiNotesSubjects, dashboardAnalytics: v.DASHBOARD_ANALYTICS === 'on',
    domainSetupReminder: v.MULTI_TENANT === 'true' && v.DOMAIN_SETUP_REMINDER === 'on', noDomainReminder: v.MULTI_TENANT === 'true' && v.NO_DOMAIN_REMINDER === 'on',
    analyticsPush: v.ANALYTICS_PUSH_URL && v.ANALYTICS_PUSH_SECRET ? { url: v.ANALYTICS_PUSH_URL, secret: v.ANALYTICS_PUSH_SECRET } : undefined,
    accountIssuer: v.ACCOUNT_ISSUER ?? 'https://account.anoma.ly', oauthScopePrefix: v.OAUTH_SCOPE_PREFIX, previousOrigins, byoStackPrefix: v.BYO_STACK_PREFIX,
    accountClient: v.ACCOUNT_CLIENT_ID && v.ACCOUNT_CLIENT_PRIVATE_KEY ? { id:v.ACCOUNT_CLIENT_ID, privateKey:v.ACCOUNT_CLIENT_PRIVATE_KEY, algorithm:v.ACCOUNT_ID_TOKEN_ALG } : undefined,
    encryptionKey: deriveEncryptionKey(v.NIGHTMAIL_ROOT_SECRET),
    previousEncryptionKey: v.PREVIOUS_NIGHTMAIL_ROOT_SECRET ? deriveEncryptionKey(v.PREVIOUS_NIGHTMAIL_ROOT_SECRET) : v.ENCRYPTION_KEY,
    publicUrl: url.origin, sesFeedbackUrl: v.SES_FEEDBACK_URL, regions, liveEnabled: v.ENABLE_LIVE_SES === 'true',
    simulatedSes: { latencyMs: v.SIMULATED_SES_LATENCY_MS, maxSendRate: v.SIMULATED_SES_RATE, deliveryDelayMs: v.SIMULATED_SES_DELIVERY_DELAY_MS },
    dispatch: { rateFactor: v.DISPATCH_RATE_FACTOR, txReservePercent: v.DISPATCH_TX_RESERVE_PERCENT, targetRate: v.DISPATCH_TARGET_RATE, dailyHeadroomPercent: v.DISPATCH_DAILY_HEADROOM_PERCENT, customerSharePercent: v.HOSTED_CUSTOMER_SHARE_PERCENT },
    aws,
    // Resource names and trusted feedback bindings are hydrated from persisted setup state.
    snsTopicArns: [], inboundTopicArns: [],
    reputationAlertUrl: v.REPUTATION_ALERT_SLACK_URL,
    screen: v.TYPESAFE_API_KEY ? { apiKey: v.TYPESAFE_API_KEY, endpoint: v.JEV_ENDPOINT, model: v.JEV_MODEL, mode: v.JEV_SCREEN_MODE, threshold: v.JEV_SCREEN_THRESHOLD, ...(jevf && { failover: jevf }) } : undefined,
    shadow: jevf, // Workers without a comparison queue disable only this handoff, not the failover gate.
    screenLimits: { messageBytes: v.JEV_MESSAGE_LIMIT_BYTES, campaignBytes: v.JEV_CAMPAIGN_LIMIT_BYTES },
    apiRateLimitPerMinute: v.API_RATE_LIMIT_PER_MINUTE,
    configurationSets: { transactional: '', marketing: '' },
  };
}
