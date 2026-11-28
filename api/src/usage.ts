import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { actor, actorMailAccess } from './core/access.js';
import { ApiError, errors, requiredOf, restrictedArea, unrestrictedRequired, notFound } from './core/errors.js';
import { isSimulatedSes } from './core/ses.js';
import { response, security } from './core/http.js';
import type { App } from './core/types.js';
import { DASHBOARD_CACHE_NOTE, dashboardRead } from './dashboard-cache.js';
import { hostedAllowance, type HostedAllowance } from './hosted-sending.js';
import { RATES } from './billing/money.js';
import { EVALUATION, GOOD_STANDING, GROWTH } from './standing-model.js';

// Plan & usage (hosted only): what the dashboard's Plan & usage page and an agent need to answer "what does this cost
// and how much can I send". The prices are billing's (billing/money.ts RATES); billing.enforcement says whether usage is
// charged yet (the balance itself is GET /v1/billing). The daily
// limit is the same allowance admission enforces (hosted_allowance_read, no locks): the evaluation's, then none in good
// standing. One statement after authentication.
const Step = z.object({
  cap: z.number().int().describe('Recipients per rolling 24 hours at this step.'),
  requires: z.string().describe('What a workspace needs to reach this step, in plain words.'),
});
const Usage = z.object({
  billing: z.object({
    enabled: z.boolean().describe('Usage is taken from the prepaid balance (enforcement is enforce).'),
    enforcement: z.enum(['off', 'shadow', 'enforce']).describe('off or shadow: nothing is charged yet (shadow records what would be); enforce: usage is charged hourly. The balance is GET /v1/billing.'),
  }),
  pricing: z.object({
    currency: z.literal('USD'),
    perThousand: z.number().describe('Price per 1,000 emails: each recipient of a sent email, each received message. SES mailbox simulator sends count like any other send.'),
    freeEmails: z.number().int().describe('The sent allowance (same as freeSentEmails), kept for older clients. Sent and received each have their own allowance (freeSentEmails, freeReceivedEmails), counted separately: sends beyond theirs are charged even while received mail is still free, and the other way round.'),
    freeSentEmails: z.number().int().describe('Sent emails (each recipient) included free each calendar month (UTC).'),
    freeReceivedEmails: z.number().int().describe('Received messages included free each calendar month (UTC), separate from the sent allowance.'),
    freeStorageBytes: z.number().int().describe('Bytes of received mail older than 90 days stored free.'),
  }),
  month: z.object({
    from: z.iso.datetime().describe('Start of the current calendar month, UTC.'),
    sent: z.number().int().describe('Emails created this month, each counted once however many recipients it has.'),
    received: z.number().int().nullable().describe('Messages received this month on any address, routed, unrouted or spam. Null unless the credential may read every received message (owners, admins and manage credentials): members and read-only keys never learn about mail they can\'t open.'),
    billedSent: z.number().int().describe('Sent emails billing counts this month, each recipient once (Hosted sending; mail canceled or rejected before it went out is taken off). The free sent allowance and the price apply to this count.'),
    billedReceived: z.number().int().nullable().describe('Received messages billing counts this month: mail Amazon\'s spam scan flagged and simulated mail are free. The free received allowance and the price apply to this count. Null like received.'),
  }),
  daily: z.object({
    cap: z.number().int().nullable().describe('Recipients allowed per rolling 24 hours; null when this workspace has no daily limit.'),
    used: z.number().int().describe('Recipients charged in the rolling 24 hours, SES mailbox simulator addresses included.'),
    resetAt: z.iso.datetime().nullable().describe('When capacity next frees up or the limit changes.'),
    step: z.number().int().nullable().describe('Index into steps of the step this workspace is on; null past them: no daily limit (cap null), or one set by the score, a warning or an operator.'),
  }).nullable().describe('Null until the workspace connects hosted sending.'),
  steps: z.array(Step).describe(`The daily limits a new workspace passes through: only the evaluation. After it, a workspace in good standing (score ${GOOD_STANDING} and up, no warning) has no daily limit; bad signals set one (GET /v1/sender-score). Only real SES acceptances count: simulated sends and simulator addresses use the limit but never end the evaluation.`),
  simulated: z.boolean().describe('This installation simulates SES: no email leaves it, and simulated sends never count against the daily limit.'),
}).openapi('Usage');

export function usageSteps(caps: { firstWeek: number }): z.infer<typeof Step>[] {
  return [{ cap: caps.firstWeek, requires: `The evaluation: a new workspace's first ${EVALUATION.recipients} real recipients. It ends once their delivery results are in, about an hour after the ${EVALUATION.recipients}th; then sending grows from ${GROWTH.start.toLocaleString('en-US')} recipients an hour for ${GROWTH.hours} clean hours.` }];
}
export const PRICING = { currency: 'USD', perThousand: Number(RATES.emailUc) * 1000 / 100_000_000, freeEmails: RATES.freeSentEmails, freeSentEmails: RATES.freeSentEmails, freeReceivedEmails: RATES.freeReceivedEmails, freeStorageBytes: Number(RATES.freeStorageBytes) } as const;

export function registerUsage(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/usage', operationId: 'getUsage', tags: ['Metrics'], security, summary: 'Plan, pricing and sending limits',
    description: 'Hosted only. Pricing and whether billing charges yet, this month\'s sent and received counts against their free allowances (' + RATES.freeSentEmails.toLocaleString('en-US') + ' sent and ' + RATES.freeReceivedEmails.toLocaleString('en-US') + ' received), counted separately (received only for credentials that may read all received mail), and the rolling daily sending limit (none in good standing) with the evaluation before it. Workspace-wide: keys restricted to domains get 403. ' + DASHBOARD_CACHE_NOTE,
    responses: { 200: response(Usage), ...errors } }), async c => {
    if (!c.env.config.multiTenant) return notFound('Endpoint');
    const a = actor(c, 'read');
    if (a.domains.length) throw unrestrictedRequired(a, restrictedArea(c.req.path), requiredOf(c, 'read'));
    // The received count includes unrouted and spam mail, so it belongs to whoever may list all of it (listInboundMessages
    // as an administrator). Anyone else could otherwise poll it around a probe to learn which addresses take mail.
    const receiving = actorMailAccess(a)?.admin === true;
    const compute = async () => {
      const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
      // Both counts are index-only scans (sending_emails_created_page, mail_messages_tenant_page).
      // The billed counts are the meters billing prices (billing_usage_hourly): recipients, not messages.
      const { rows: [row] } = await c.env.db.execute<{ sent: number; received: number | null; billed_sent: number; billed_received: number | null; allowance: HostedAllowance | null; enforcement: 'off' | 'shadow' | 'enforce' | null }>(sql`SELECT
        (SELECT count(*)::int FROM sending_emails WHERE workspace_id = ${a.workspaceId} AND created_at >= ${month}::timestamptz) AS sent,
        ${receiving ? sql`(SELECT count(*)::int FROM mail_messages WHERE workspace_id = ${a.workspaceId} AND direction = 'inbound' AND received_at >= ${month}::timestamptz)` : sql`NULL::int`} AS received,
        (SELECT greatest(0, coalesce(sum(quantity), 0))::int FROM billing_usage_hourly WHERE workspace_id = ${a.workspaceId} AND meter = 'send' AND hour >= ${month}::timestamptz) AS billed_sent,
        ${receiving ? sql`(SELECT greatest(0, coalesce(sum(quantity), 0))::int FROM billing_usage_hourly WHERE workspace_id = ${a.workspaceId} AND meter = 'receive' AND hour >= ${month}::timestamptz)` : sql`NULL::int`} AS billed_received,
        ${hostedAllowance(c.env.config, a.workspaceId, 1, 0, true)} AS allowance,
        (SELECT mode FROM billing_config WHERE singleton) AS enforcement`);
      const steps = usageSteps(c.env.config.hostedSendCaps), allowance = row?.allowance ?? null;
      // A cap that matches no step was set by the score, a warning or an operator; none is past every step.
      const index = allowance?.cap == null ? -1 : steps.findIndex(s => s.cap === allowance.cap);
      return {
        billing: { enabled: row?.enforcement === 'enforce', enforcement: row?.enforcement ?? 'off' }, pricing: PRICING,
        month: { from: month, sent: row?.sent ?? 0, received: receiving ? row?.received ?? 0 : null, billedSent: row?.billed_sent ?? 0, billedReceived: receiving ? row?.billed_received ?? 0 : null },
        daily: allowance ? { cap: allowance.cap, used: Number(allowance.used), resetAt: allowance.resetAt ? new Date(allowance.resetAt).toISOString() : null, step: index < 0 ? null : index } : null,
        steps,
        simulated: isSimulatedSes(c.env),
      };
    };
    if (a.credential !== 'dashboard') return c.json(await compute(), 200);
    // The scope keeps the two views apart: a member's read is never served an owner's received count.
    const body = await dashboardRead(c, ['usage', a.workspaceId, receiving ? 'all' : 'sent', Math.floor(Date.now() / 60_000)].join('|'), compute);
    c.header('x-nightmail-usage-cache', body.cache);
    return c.json(body.value, 200);
  });
}
