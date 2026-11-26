import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { bounded, utc, type Hosted } from './abuse.js';
import { accessed, BANDS, REASON_CODES, type Band, type ClusterChange, type Reason } from './abuse-clusters.js';
import { operatorContext, recordAudit } from './audit.js';
import { errors, json, log, notFound, response, security, type App } from './core.js';
import { operatorActor } from './operator.js';

// Abuse monitoring, part 3: the alert outbox and its review. When a cluster first reaches a level a person should look
// at (review or high), climbs a level or gains a member there, one alert is stored with its Slack message. Only review
// alerts are posted: to ABUSE_SLACK_WEBHOOK_URL, else to the operator alerts' webhook (config.ts); high ones, and every
// alert when neither is set, are only stored. Operators read them in the Operator area either way, and review one from its cluster's page: Watch
// (reviewed, keep tracking: raised again only at a higher level) or Dismiss (not abuse: raised again only with a member
// or a reason it did not have). Pause is there too, on each workspace.
//
// A message holds no personal data and no evidence: a risk level, reasons in fixed words, counts, workspace IDs and a
// link into the Operator area (a staff sign-in). Never a workspace's name (it can be a person's), an address, a domain,
// a signal's value or anything a customer wrote. The payload and the webhook URL are never logged.

const rank = (band: Band) => BANDS.indexOf(band);
export type AlertKind = 'new' | 'raised' | 'grew';
/** Whether a change to a cluster is worth an alert: it first reached review or high, climbed a level, or gained a member there. */
export function alertFor(change: ClusterChange): AlertKind | null {
  if (rank(change.band) < rank('review')) return null;
  if (!change.previous || rank(change.previous.band) < rank('review')) return 'new';
  if (rank(change.band) > rank(change.previous.band)) return 'raised';
  return change.members > change.previous.members ? 'grew' : null;
}
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/, CODES: readonly string[] = REASON_CODES, WORKSPACES_SHOWN = 3, REASONS_SHOWN = 3;
const bandName = { review: 'Review', high: 'High' } as const, kindName: Record<AlertKind, string> = { new: 'New', raised: 'Risk raised', grew: 'New member' };
const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : `${one}s`}`;
// Each reason in plain words, with its count where the count is something a person can picture. MULTI_ACCOUNT is the
// message's first line.
const WHY: Record<string, (count: number) => string> = {
  FREE_TIER_MULTIPLIED: n => `free allowance shared across ${plural(n, 'workspace')}`,
  THROWAWAY_SIGNUP: () => 'throwaway or look-alike sign-up addresses',
  SIGNUP_BURST: n => `${plural(n, 'sign-up')} from one network within a day`,
  SHARED_CARD: () => 'the same payment card',
  PAYMENT_RISK: () => 'disputed or failing payments',
  SIMILAR_CONTENT: () => 'near-identical mail',
  SHARED_LINKS: () => 'mail linking to the same sites',
  SENDER_STANDING: () => 'a sending warning, hold or pause',
  FAST_FIRST_SEND: () => 'API sends within 10 minutes of sign-up',
  WAITLIST_REPEAT: n => plural(n, 'repeated sign-in refusal'),
};
/** What the cluster's workspaces sent in the last seven days: accepted emails, and of them the bounces and complaints. */
export type Sent = { emails: number; bounced: number; complained: number };
const share = (part: number, whole: number, digits: number) => `${(part / whole * 100).toFixed(digits).replace(/\.0+$/, '')}%`;
/**
 * The Slack message for one alert: one line (level, score, accounts) and three bullets (who, why, what they sent), with
 * a button to its cluster in the Operator area. Built only from a level, numbers, reason codes on the fixed list and IDs
 * of a safe shape; anything else is left out. No mentions, no unfurls.
 */
export function slackCard(publicUrl: string, alert: { cluster: string; band: 'review' | 'high'; score: number; kind: AlertKind; accounts: number; reasons: Reason[]; workspaces: string[]; sent: Sent }) {
  const origin = publicUrl.replace(/\/$/, ''), ids = alert.workspaces.filter(id => SAFE_ID.test(id)), more = ids.length - WORKSPACES_SHOWN, { emails, bounced, complained } = alert.sent;
  const head = `${bandName[alert.band]} risk ${alert.score}: ${plural(alert.accounts, 'related account')}${alert.kind === 'new' ? '' : ` (${kindName[alert.kind].toLowerCase()})`}`;
  const who = ids.length ? `${plural(ids.length, 'workspace')}: ${ids.slice(0, WORKSPACES_SHOWN).map(id => `\`${id}\``).join(', ')}${more > 0 ? ` and ${more} more` : ''}` : 'sign-ins only, no workspace';
  const why = alert.reasons.filter(reason => CODES.includes(reason.code) && WHY[reason.code] && Number.isInteger(reason.points)).sort((a, b) => b.points - a.points).slice(0, REASONS_SHOWN)
    .map(reason => WHY[reason.code]!(Number.isInteger(reason.count) ? reason.count! : 0));
  const sent = emails > 0 ? `${plural(emails, 'email')}, ${share(bounced, emails, 1)} bounced, ${share(complained, emails, 2)} complaints` : 'nothing';
  return {
    text: head, unfurl_links: false, unfurl_media: false,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: [`*${head}*`, `• *Who:* ${who}`, `• *Why:* ${why.join('; ') || 'shared sign-in signals'}`, `• *Sent in 7 days:* ${sent}`].join('\n') } },
      { type: 'actions', elements: [{ type: 'button', action_id: 'review', style: 'primary', text: { type: 'plain_text', text: 'Review in Operator', emoji: false }, url: `${origin}/operator/abuse/${encodeURIComponent(alert.cluster)}` }] },
    ],
  };
}
/**
 * Stores an alert for a cluster's change, with what its workspaces sent this week, unless one already covers it:
 * - an alert for the cluster at this level in the last seven days;
 * - alerts at this level or above in the last seven days that named every one of its workspaces;
 * - a Watch on the cluster, or on an alert that named all its members, at this level or above;
 * - a Dismiss on an alert that named all its members and all its reasons. A dismissed alert covers nothing else.
 * Returns its ID, or null.
 */
export async function noteAlert(runtime: Hosted, change: ClusterChange) {
  const kind = alertFor(change), band = change.band;
  if (!kind || (band !== 'review' && band !== 'high')) return null;
  const id = `aal_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`, keys = sql.param(change.keys), codes = sql.param(change.reasons.map(reason => reason.code));
  const workspaces = sql.param(change.workspaces.map(workspace => `workspace:${workspace}`)), atLeast = sql`(a.band=${band}::text OR a.band='high')`, recent = sql`a.created_at>now()-interval '7 days' AND a.review IS DISTINCT FROM 'dismiss'`;
  return bounded(runtime, async tx => {
    const { rows: [sent] } = await tx.execute<{ emails: string; bounced: string; complained: string }>(sql`SELECT coalesce(sum(accepted),0)::text AS emails,coalesce(sum(bounced),0)::text AS bounced,coalesce(sum(complained),0)::text AS complained
      FROM sending_metrics_hourly WHERE workspace_id=ANY(${sql.param(change.workspaces)}::text[]) AND hour>now()-interval '7 days'`);
    const payload = slackCard(runtime.config.publicUrl, { cluster: change.id, band, score: change.score, kind, accounts: change.accounts, reasons: change.reasons, workspaces: change.workspaces,
      sent: { emails: Number(sent?.emails ?? 0), bounced: Number(sent?.bounced ?? 0), complained: Number(sent?.complained ?? 0) } });
    const { rows } = await tx.execute(sql`INSERT INTO abuse_alerts(id,cluster_id,band,score,kind,workspaces,payload,members,reasons)
      SELECT ${id},${change.id},${band},${change.score},${kind},${change.workspaces.length},${JSON.stringify(payload)}::jsonb,${keys}::text[],${codes}::text[]
      WHERE NOT EXISTS (SELECT FROM abuse_alerts a WHERE a.cluster_id=${change.id} AND a.band=${band}::text AND ${recent})
        AND (cardinality(${workspaces}::text[])=0 OR EXISTS (SELECT FROM unnest(${workspaces}::text[]) w(key) WHERE NOT EXISTS (
          SELECT FROM abuse_alerts a WHERE ${recent} AND ${atLeast} AND w.key=ANY(a.members))))
        AND NOT EXISTS (SELECT FROM abuse_alerts a WHERE a.review='watch' AND (a.cluster_id=${change.id} OR a.members @> ${keys}::text[]) AND ${atLeast})
        AND NOT EXISTS (SELECT FROM abuse_alerts a WHERE a.review='dismiss' AND a.members @> ${keys}::text[] AND a.reasons @> ${codes}::text[])
      RETURNING id`);
    return rows.length ? id : null;
  });
}
export type SlackPost = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; redirect: 'manual'; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; body?: { cancel(): Promise<void> } | null }>;
const POSTED_AN_HOUR = 3, ATTEMPTS_MOST = 5;
/**
 * The delivery adapter: posts the stored review alerts of the last day that nobody has reviewed and whose cluster is
 * still at review or high, oldest first, at most POSTED_AN_HOUR in any hour; the rest wait for the next run. High
 * alerts are never posted: operators read them in the Operator area.
 * Without a webhook it does nothing and alerts stay stored. A post that fails is tried again after 50 minutes, then
 * 100, 200 and 400 (the job runs hourly), five times in all; one that succeeds is marked sent. Runs inside the hourly
 * job's lease, so two runs never post the same alert.
 */
export async function deliverAlerts(runtime: Hosted, deadline: number, post: SlackPost = fetch) {
  const url = runtime.config.abuseSlackWebhookUrl;
  if (!url) return 0;
  const due = await bounded(runtime, async tx => {
    const { rows: [posted] } = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM abuse_alerts WHERE sent_at>now()-interval '1 hour'`);
    const room = POSTED_AN_HOUR - (posted?.n ?? 0);
    if (room <= 0) return [];
    return (await tx.execute<{ id: string; payload: unknown }>(sql`SELECT a.id,a.payload FROM abuse_alerts a JOIN abuse_clusters c ON c.id=a.cluster_id AND c.band IN ('review','high')
      WHERE a.band='review' AND a.status='stored' AND a.review IS NULL AND a.created_at>now()-interval '1 day' AND (a.retry_at IS NULL OR a.retry_at<=now())
      ORDER BY a.created_at LIMIT ${room}`)).rows;
  });
  let sent = 0;
  for (const alert of due) {
    if (Date.now() >= deadline) break;
    let error: string | null = null;
    try {
      // Never follow a redirect: the message goes to the configured webhook only.
      const answer = await post(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(alert.payload), redirect: 'manual', signal: AbortSignal.timeout(5000) });
      await answer.body?.cancel().catch(() => undefined);
      if (!answer.ok) error = `HTTP_${answer.status}`;
    } catch { error = 'UNREACHABLE'; }
    if (!error) sent++; else log('warn', { code: 'ABUSE_ALERT_FAILED', reason: error });
    await bounded(runtime, tx => tx.execute(sql`UPDATE abuse_alerts SET attempts=attempts+1,error=${error},sent_at=CASE WHEN ${error === null} THEN now() END,
      status=CASE WHEN ${error === null} THEN 'sent' WHEN attempts+1>=${ATTEMPTS_MOST} THEN 'failed' ELSE 'stored' END,
      retry_at=CASE WHEN ${error === null} THEN NULL ELSE now()+interval '50 minutes'*power(2,attempts) END WHERE id=${alert.id}`));
  }
  return sent;
}

const Review = z.object({ action: z.enum(['watch', 'dismiss']), at: z.string(), by: z.string().nullable().describe("The operator's sign-in address, while their account exists.") });
const Alert = z.object({ id: z.string(), clusterId: z.string(), band: z.enum(['review', 'high']), score: z.number().int(), kind: z.enum(['new', 'raised', 'grew']), workspaces: z.number().int(),
  status: z.enum(['stored', 'sent', 'failed']), attempts: z.number().int(), createdAt: z.string(), sentAt: z.string().nullable(), payload: z.unknown().describe('The Slack message as it is, or would be, posted.'),
  review: Review.nullable().describe('watch: reviewed, raised again only at a higher level. dismiss: not abuse, raised again only with a member or a reason it did not have.') }).openapi('OperatorAbuseAlert');
const alertColumns = sql`a.id,a.cluster_id AS "clusterId",a.band,a.score,a.kind,a.workspaces,a.status,a.attempts,${utc(sql`a.created_at`)} AS "createdAt",
  CASE WHEN a.sent_at IS NOT NULL THEN ${utc(sql`a.sent_at`)} END AS "sentAt",a.payload,
  CASE WHEN a.review IS NOT NULL THEN jsonb_build_object('action',a.review,'at',${utc(sql`a.reviewed_at`)},'by',u.email) END AS review`;
const alertFrom = sql`abuse_alerts a LEFT JOIN nightmail_users u ON u.id=a.reviewed_by`;
export function registerAbuseAlerts(app: App) {
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/abuse/alerts', operationId: 'operatorListAbuseAlerts',
    request: { query: z.object({ cluster: z.string().regex(/^acl_[0-9a-f]{24}$/).optional().describe("Only this cluster's alerts."),
      cursor: z.string().max(100).regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|aal_[0-9a-f]{24}$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) },
    responses: { 200: response(z.object({ data: z.array(Alert), nextCursor: z.string().nullable(), delivery: z.enum(['slack', 'off']).describe('off: no Slack webhook is configured, so alerts are only stored.') })), ...errors } }), async c => {
    const operator = await operatorActor(c, 'operator:read'), q = c.req.valid('query'), [after, afterId] = q.cursor?.split('|') ?? [];
    await accessed(c, operator, 'abuse.alerts', q.cluster);
    const { rows } = await c.env.db.execute<z.infer<typeof Alert>>(sql`SELECT ${alertColumns} FROM ${alertFrom} WHERE true ${q.cluster ? sql`AND a.cluster_id=${q.cluster}` : sql``}
      ${after ? sql`AND (a.created_at,a.id)<(${after}::timestamptz,${afterId})` : sql``} ORDER BY a.created_at DESC,a.id DESC LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit), last = page.at(-1);
    return c.json({ data: page, nextCursor: rows.length > q.limit && last ? `${last.createdAt}|${last.id}` : null, delivery: c.env.config.abuseSlackWebhookUrl ? 'slack' as const : 'off' as const }, 200);
  });
  // Watch or Dismiss, by an operator: recorded on the alert (who, when) and in the staff audit. A queued alert so reviewed
  // is not posted. Deciding again replaces the decision.
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/abuse/alerts/{id}/review', operationId: 'operatorReviewAbuseAlert',
    request: { params: z.object({ id: z.string().regex(/^aal_[0-9a-f]{24}$/) }), body: json(z.object({ action: z.enum(['watch', 'dismiss']) }).strict()) },
    responses: { 200: response(Alert), ...errors } }), async c => {
    const operator = await operatorActor(c, 'operator'), id = c.req.valid('param').id, { action } = c.req.valid('json');
    const alert = await c.env.db.transaction(async tx => {
      const { rows: [row] } = await tx.execute<{ cluster_id: string; previous: string | null }>(sql`UPDATE abuse_alerts a SET review=${action},reviewed_by=${operator.userId},reviewed_at=now()
        FROM (SELECT id,review FROM abuse_alerts WHERE id=${id} FOR UPDATE) old WHERE a.id=old.id RETURNING a.cluster_id,old.review AS previous`);
      if (!row) notFound('Alert');
      await recordAudit(tx, operatorContext(c, { id: operator.userId, role: operator.role, via: 'console', userId: operator.userId }),
        { action: `abuse.alert_${action}`, workspaceId: null, target: { type: 'abuse_alert', id }, details: { cluster: row!.cluster_id, previous: row!.previous }, internal: true });
      return (await tx.execute<z.infer<typeof Alert>>(sql`SELECT ${alertColumns} FROM ${alertFrom} WHERE a.id=${id}`)).rows[0]!;
    });
    return c.json(alert, 200);
  });
}

// Disposable landing-batch CI proof; no runtime change.
