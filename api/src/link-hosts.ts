/**
 * Link hosts (src/link-domains.ts): the link domain (links.nightmailedge.com, Hosted) and customers' own links.<domain>
 * (custom hostnames, when on), names of the link zone, which Cloudflare routes to the Worker (a `*\/*` route on that zone).
 * Such a host answers the links in customer mail and nothing else: no dashboard, API, docs or redirect to this
 * installation's own domain on a name customer mail carries. No imports, so the Worker decides before it loads the API.
 */
/** The label of a domain's link host. */
export const LINK_LABEL = 'links';
/**
 * How long a deleted domain's link host goes on answering the links in mail it already sent (src/link-domains.ts retires
 * it): an opt-out has to keep working for 30 days after a message is sent (CAN-SPAM), and no mail links on the host once
 * its domain is gone, so 30 days from the deletion covers every message.
 */
export const LINK_RETENTION_DAYS = 30;
// Unsubscribe links (the page and the one-click POST), forwarding's confirm and stop pages, linked images (/i/), and the
// fonts the unsubscribe page uses. One segment after each prefix: nothing else is a link.
const LINK_PATH = /^\/(?:unsubscribe|v1\/forwarding\/(?:confirm|stop)|i|fonts)\/[^/]+$/;
const DCV_PATH = /^\/\.well-known\/(?:acme-challenge|pki-validation)\//;

/**
 * How the Worker answers a request on `host`. `other`: one of this installation's own hosts (`own`), or link hosts are
 * off. `link`: a link on a customer's link host, for the API's handlers (never the dashboard's shell). `missing`:
 * anything else there. `pass`: a host that is no link host, handed on untouched to its own origin. With link hosts on, every host that is none of `own` came through the SaaS zone.
 */
export function linkHostRequest(enabled: boolean, host: string, path: string, own: readonly string[]): 'other' | 'link' | 'missing' | 'pass' {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (!enabled || own.includes(name) || ['localhost', '127.0.0.1', '[::1]'].includes(name)) return 'other';
  // Not a link host (always links.<domain>): a name of the zone the zone-wide route caught by mistake, such as another
  // Worker's custom domain or an R2 bucket's. Routes run before custom domains, so the Worker passes it on to its origin.
  if (!name.startsWith(`${LINK_LABEL}.`)) return 'pass';
  // Certificate validation (HTTP DCV) for the host's own certificate: Cloudflare answers it, never this Worker's 404.
  if (DCV_PATH.test(path)) return 'pass';
  return LINK_PATH.test(path) ? 'link' : 'missing';
}
