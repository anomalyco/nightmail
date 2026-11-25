/**
 * The product's public identity in one place: its name, the hosted origin, the addresses people write to, and the
 * names integrations see. The API, dashboard and support Worker import this file; `bun run sdk` (in api/) copies it
 * verbatim to sdk/src/brand.ts, so edit only api/src/brand.ts. It imports nothing, so every package compiles it.
 *
 * Bane became Nightmail (nightmail.dev). The hosted service is on nightmail.dev; bane.mx, its earlier domain, is in
 * `previousDomains` and stays served (API, SNS feedback, unsubscribe links; GETs redirect). A name a customer may already
 * have (key prefix, DNS proof, header, scope, cookie) stays accepted until the cutover, which removes them all at once
 * (each site is marked "remove after rename cleanup"). Infrastructure names (Workers, buckets, SES resources) are not here.
 */
export const productName = 'Nightmail';
/** Lowercase, for identifiers. */
export const productSlug = 'nightmail';
/** Earlier names, newest first. Still accepted wherever a customer may have saved one. */
export const legacySlugs = ['bane', 'opensend'] as const;

/** The product's own domain. The hosted service moves to it once it is live. */
export const productDomain = 'nightmail.dev';
/** The hosted service's domain: dashboard, API, docs and /mcp, with support.<domain> beside it and dev.<domain>. */
export const hostedDomain = 'nightmail.dev';
/** Domains the hosted service answered on before `hostedDomain`, still served. */
export const previousDomains: readonly string[] = ['bane.mx'];
export const servedDomains: readonly string[] = [hostedDomain, ...previousDomains];
/** Every dashboard and API host of the hosted service: production and dev, on each served domain. */
export const hostedHosts: readonly string[] = servedDomains.flatMap(domain => [domain, `dev.${domain}`]);
/** The support Worker's host beside a dashboard host (support.nightmail.dev, support.dev.nightmail.dev). */
export const supportHost = (host: string) => `support.${host}`;

/**
 * The hosted origin. A running installation uses its own: PUBLIC_URL in the API, VITE_PUBLIC_URL or the page's origin
 * in the dashboard, BANE_ORIGIN in the support Worker. This is their default and the origin examples are written for.
 */
export const publicOrigin = `https://${hostedDomain}`;
export const docsUrl = `${publicOrigin}/docs`;
export const mcpUrl = `${publicOrigin}/mcp`;
export const repositoryUrl = 'https://github.com/anomalyco/nightmail';

/** Where people write to the hosted service. The same addresses at previousDomains still reach the team. */
export const addresses = {
  support: `support@${hostedDomain}`,
  abuse: `abuse@${hostedDomain}`,
  privacy: `privacy@${hostedDomain}`,
  legal: `legal@${hostedDomain}`,
  security: `security@${hostedDomain}`,
} as const;

/** The npm package (@banemx/sdk before the rename, now deprecated), the environment variable examples keep an API key
 * in, and the server name MCP client configs save. */
export const sdkPackage = '@nightmail/sdk';
export const apiKeyEnv = 'NIGHTMAIL_API_KEY';
/** Where an agent's config reads a key limited to an inbox or addresses from. */
export const inboxKeyEnv = 'NIGHTMAIL_INBOX_KEY';
export const mcpServerName = 'nightmail';
/** /health names the service by its slug. */
export const healthService = productSlug;
/** The native inbound webhook format (thin signed events), as requests name it and responses show it. */
export const webhookFormat = productSlug;
/** The client's address as the entry point (server.ts, worker.ts) saw it, on the request the API handles. The entry
 *  point overwrites any value the request carried. */
export const clientIpHeader = `x-${productSlug}-client-ip`;
/** The client's network as Cloudflare saw it, "AS<number>;<country>", on the request the API handles. The entry point
 *  (server.ts, worker.ts) removes any value the request carried; only the Worker sets one. Read by src/abuse.ts. */
export const clientNetworkHeader = `x-${productSlug}-client-network`;
/** Environment variable names, current first: NIGHTMAIL_<name>, then its earlier names (legacyEnvPrefixes). */
export const envNames = (name: string) => [`NIGHTMAIL_${name}`, ...legacyEnvPrefixes.map(prefix => prefix + name)];
/** The names of a server setting (config.ts and the operator scripts): NIGHTMAIL_<name>, then legacySettingPrefixes. */
export const settingNames = (name: string) => [`NIGHTMAIL_${name}`, ...legacySettingPrefixes.map(prefix => prefix + name)];
/** A setting's value under the first of its names the environment sets. */
export const setting = (env: object, name: string): string | undefined => {
  for (const key of settingNames(name)) { const value = (env as Record<string, unknown>)[key]; if (typeof value === 'string') return value; }
  return undefined;
};

/** OAuth scope prefixes the MCP server accepts (nightmail:read, …). Which one it asks for is OAUTH_SCOPE_PREFIX
 * (config.ts): bane until account.anoma.ly supports nightmail:*. bane: remove after rename cleanup. */
export const oauthScopePrefixes = [productSlug, 'bane'] as const;
export type OauthScopePrefix = typeof oauthScopePrefixes[number];
/** The scopes an installation asks for, for read, send and manage. */
export const requestedScopes = (config: { oauthScopePrefix?: OauthScopePrefix }) => (['read', 'send', 'manage'] as const).map(p => `${config.oauthScopePrefix ?? 'bane'}:${p}`);

/** Prefixes of the secrets this service issues, by kind. New secrets get these. */
export const secretPrefixes = { apiKey: 'nm_', addressKey: 'nm_mbx_', agentToken: 'nm_agent_', supportGrant: 'nm_support_', notesKey: 'nm_notes_', agentSetup: 'nm_setup_', deviceCode: 'nm_device_' } as const;
/** Earlier prefixes stay valid: bane_… and, before it, OpenSend's os_…. Remove after rename cleanup. */
export const legacySecretPrefixes = ['bane', 'os'] as const;
/** What a key list shows of a new secret: its kind's prefix and the first 8 characters after it. */
export const shownPrefix = (secret: string) => secret.slice(0, secret.lastIndexOf('_') + 9);
/** Any secret of ours (current or earlier prefix) inside text, for redaction. Use with replace or matchAll. */
export const ownSecretPattern = /\b(?:nm|bane|os)_[A-Za-z0-9_.-]{20,}/g;

/** User-Agent of the webhook deliveries this service makes. */
export const webhookUserAgent = `${productName}-Webhooks/1.0`;
/** Marks a test delivery to a webhook. Bane-Test is still sent too (remove after rename cleanup). */
export const webhookTestHeaders = [`${productName}-Test`, 'Bane-Test'] as const;

/** Request headers are X-Nightmail-<name>. */
export const headerPrefix = `X-${productName}-`;
/** A request header's accepted names, current first: X-Nightmail-, then X-Bane- and X-OpenSend- (remove after rename cleanup). */
export const requestHeaderNames = (name: string) => [productSlug, ...legacySlugs].map(slug => `x-${slug}-${name.toLowerCase()}`);
/** The first accepted name a request carries. */
export const requestHeader = (headers: { get(name: string): string | null }, name: string) => {
  for (const candidate of requestHeaderNames(name)) { const value = headers.get(candidate); if (value !== null) return value; }
  return null;
};
/** Added to mail a rule forwards; any accepted name on incoming mail stops a forwarding loop. */
export const loopHeader = `${headerPrefix}Loop`;
export const loopHeaderNames = requestHeaderNames('loop');

/** Domain Connect provider IDs of the mail template (domain-connect/<id>.mail.json), preferred first: one-click DNS applies the
 * first one the domain's DNS provider lists. A provider ID never follows the brand: a new one is registered and onboarded with
 * each DNS provider again, so list it before the current one until providers have it. */
export const domainConnectProviderIds = ['nightmail.dev'] as const;

// ---------- Earlier public names, accepted until the domain cutover (remove after rename cleanup) ----------
// Only the names above are emitted. Each one here is still accepted where a customer, a stored row or a deployment
// may use it. The cutover deletes this section (and the other "remove after rename cleanup" sites) and fixes each site
// the compiler then names.

/** Environment variable prefixes before NIGHTMAIL_, newest first. The server's own settings also took MX_. */
export const legacyEnvPrefixes = ['BANE_'] as const, legacySettingPrefixes = ['BANE_', 'MX_'] as const;
/** /health services a probe accepts: this one, and the earlier names a deployment from before the rename answers with. */
export const healthServices = [healthService, ...legacySlugs] as const;
/** The native webhook format's earlier name. Requests may still name it, and stored webhooks still hold it (the database
 *  constrains and compares the stored value), so every existing webhook delivers exactly as before. */
export const legacyWebhookFormat = 'bane';
/** The SDK's NightmailUploadError, also exported under these earlier names (deprecated). */
export const legacySdkErrors = ['BaneUploadError', 'OpenSendUploadError'] as const;
/** Earlier names of clientIpHeader. Never read: the entry point removes them from every request it receives. */
export const legacyClientIpHeaders = ['x-bane-client-ip', 'x-opensend-client-ip'] as const;
/** The address routes and SDK methods, deprecated aliases since every address became an inbox (migration addresses_are_inboxes). Read an
 *  address's mail with the inbox routes. The cutover removes these and lets /v1/inboxes list and create addresses, which its
 *  Inbox schema (replyOnly, retention mode) can't describe without a breaking change. */
export const legacyAddressOperations = ['listInboundAddresses', 'createInboundAddress', 'getInboundAddress', 'updateInboundAddress', 'deleteInboundAddress'] as const;
