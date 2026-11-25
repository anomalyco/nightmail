import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { ApiError, log, notFound, type App, type Config, type Runtime } from './core.js';
import { cardName, slackCard } from './operator-alerts.js';
import { postSlack } from './reputation-alerts.js';

// Database disk alert (hosted): PlanetScale calls this when the Postgres cluster's disk crosses 60, 75, 85, 90 or 95%
// (its cluster.storage webhook event), and one card goes to OPERATOR_SLACK_WEBHOOK_URL. Near 95% PlanetScale makes the
// cluster read-only, so nothing here reads or writes the database: no session, no job, no dedupe row, no budget.
//
// PlanetScale authenticates with the Authorization header it is given: a token derived from the root secret, which a
// full operator reads once at GET /v1/operator/database-disk-alert (src/operator.ts) and pastes into the webhook.
// PlanetScale stores it write-only. Once PLANETSCALE_WEBHOOK_SECRET is set, its X-PlanetScale-Signature must match too.
// https://planetscale.com/docs/api/webhooks, https://planetscale.com/docs/api/webhook-events#cluster-storage

export const DISK_ALERT_PATH = '/internal/v1/database-disk';
const CARD = { emoji: ':minidisc:', label: 'Database disk' };
const THRESHOLDS = [95, 90, 85, 75, 60];
/**
 * An event is taken while its own timestamp is at most this old (or this far ahead): a captured delivery can't be
 * replayed later, and one PlanetScale delivers late still posts while it says something about the disk.
 */
const MAX_AGE_S = 60 * 60;

// HKDF with its own label: the token says nothing about the root secret or any other key derived from it. Changing
// the label revokes it.
const token = (secret: string) => 'nmdisk_' + Buffer.from(hkdfSync('sha256', secret, '', 'nightmail:disk-alert:v1', 32)).toString('base64url');
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
/** What PlanetScale's webhook is set to. The Authorization value is a credential: never log it. */
export const diskAlertSetup = (config: Pick<Config, 'authSecret' | 'publicUrl'>) => ({ url: config.publicUrl.replace(/\/$/, '') + DISK_ALERT_PATH, authorization: `Bearer ${token(config.authSecret)}`, events: ['cluster.storage'] });
// The token of the previous root secret stays valid during a rotation, so the alert is never off while PlanetScale is updated.
const authorized = (config: Config, header: string | undefined) => !!header && header.length <= 200
  && [config.authSecret, config.previousAuthSecret].some(secret => !!secret && same(header, `Bearer ${token(secret)}`));
/** X-PlanetScale-Signature: the hex HMAC-SHA256 of the exact body, keyed with the webhook's secret. */
const signed = (secret: string, body: string, header: string | undefined) => !!header && same(header.toLowerCase(), createHmac('sha256', secret).update(body).digest('hex'));

// The button opens this address and no other: nothing in an event shapes a link.
const PLANETSCALE = 'https://app.planetscale.com';
// A branch is named in the card only as letters, digits, dashes and underscores (no dot: Slack links what reads like a
// domain). Any other name is left out.
const slug = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(value) ? value : null;
/**
 * The card for an event, and the limiter key it posts under: the threshold it crossed. Null for an event that posts
 * nothing. A test delivery posts a card too, so the webhook can be checked without filling a disk. From the event the
 * card takes a whole percent and, as text, the branch's name.
 */
export function diskAlertCard(event: Record<string, unknown>) {
  if (event.event === 'webhook.test') return { key: 'test', card: slackCard(CARD, 'Test from PlanetScale.', PLANETSCALE) };
  if (event.event !== 'cluster.storage') return null;
  const resource = (event.resource ?? {}) as Record<string, unknown>, branch = slug(resource.branch_name), percent = resource.storage_percentage;
  if (typeof percent !== 'number' || !(percent >= 0 && percent <= 100)) throw new ApiError(400, 'EVENT_INVALID', 'Expected a PlanetScale cluster.storage event.');
  const full = Math.floor(percent);
  return { key: String(THRESHOLDS.find(threshold => full >= threshold) ?? 0), branch, full, card: slackCard(CARD, `${branch ? `${cardName(branch)}, ` : ''}${full}% full.`, PLANETSCALE) };
}

// One card a minute per threshold (seven keys in all): a delivery repeated within the minute posts once, the next
// threshold posts at once, and whoever holds the token can post seven cards a minute at most. Counted in this process
// and, on Workers, by the DISK_ALERT limiter for its location. A limiter that fails lets the card through.
const posted = new Map<string, number>();
async function allow(runtime: Runtime, key: string) {
  const now = Date.now();
  if (now - (posted.get(key) ?? 0) < 60_000) return false;
  posted.set(key, now);
  return runtime.allowDiskAlert ? runtime.allowDiskAlert(key) : true;
}

export function registerDiskAlert(app: App) {
  // Internal: not in the OpenAPI document, the SDK or MCP. The body is bounded at 64 KiB before it gets here (app.ts).
  app.post(DISK_ALERT_PATH, async c => {
    const { config } = c.env;
    // Self-hosted, no token, a wrong one or a wrong signature: the same 404, whatever is configured.
    if (!config.multiTenant || config.planetscaleWebhookSecret === null || !authorized(config, c.req.header('authorization'))) notFound('Endpoint');
    const body = await c.req.text();
    if (config.planetscaleWebhookSecret && !signed(config.planetscaleWebhookSecret, body, c.req.header('x-planetscale-signature'))) notFound('Endpoint');
    let event: Record<string, unknown>;
    try { event = JSON.parse(body) as Record<string, unknown>; } catch { throw new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON.'); }
    if (!event || typeof event !== 'object' || typeof event.timestamp !== 'number') throw new ApiError(400, 'EVENT_INVALID', 'Expected a PlanetScale webhook event.');
    if (Math.abs(Date.now() / 1000 - event.timestamp) > MAX_AGE_S) throw new ApiError(400, 'EVENT_STALE', 'The event is not from the last hour.');
    const alert = diskAlertCard(event), url = config.operatorSlackWebhookUrl;
    if (!alert) return c.body(null, 204);
    if (!url) throw new ApiError(503, 'OPERATOR_ALERTS_OFF', 'OPERATOR_SLACK_WEBHOOK_URL is not set.', undefined, true);
    if (!await allow(c.env, alert.key)) return c.body(null, 204);
    const requestId = c.get('requestId');
    if (alert.full !== undefined) log('warn', { requestId, code: 'DATABASE_DISK_ALERT', branch: alert.branch ?? undefined, percent: alert.full });
    // PlanetScale waits two seconds for the answer and asks for it before the work, so on Workers the card is posted
    // after the response. One retry; a card Slack refuses twice is logged, and nothing delivers it later.
    const post = async () => {
      for (let attempt = 1; ; attempt++) {
        try { return await postSlack(url, alert.card, 'DISK_ALERT_FAILED'); }
        catch {
          if (attempt === 2) return log('error', { requestId, code: 'DISK_ALERT_FAILED' });
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    };
    if (c.env.deferNudge) c.env.deferNudge(post); else await post();
    return c.body(null, 204);
  });
}
