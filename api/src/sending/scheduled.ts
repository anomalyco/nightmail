import { type SQL, sql, and, eq } from 'drizzle-orm';
import { id } from '../core/http.js';
import type { JobHandler, Runtime } from '../core/types.js';
import { ApiError } from '../core/errors.js';
import { isSimulatedSes } from '../core/ses.js';
import { log } from '../log.js';
import { retryDatabaseFailures, JobDeferred, MAX_ATTEMPTS, wakeWebhooks } from '../jobs.js';
import { terminalColumns, terminalEvents, failScheduledRelease } from '../states.js';
import { hostedCost } from '../hosted-sending.js';
import { emails } from '../db/sending.js';
import { linkAllowance, recordLinkUse } from '../link-domains.js';
import { type AdmissionMail, admission, actorJson, charges, type Admitted, type Refused, shadowBilling } from '../admission.js';
import { SEND_LIMITS, contentBytes } from '../send-limits.js';
import { resolveHostedContentPolicy } from './mime.js';

// ── Scheduled single sends (sendEmail scheduledAt) ──
// A scheduled email is a sending_emails row in status scheduled, which the dispatcher never leases, plus one release job
// keyed by the email (like a campaign's run). Rescheduling requeues that job with a fresh run token, which the runner
// fences its settlement on, so a worker that already decided to wait for the old time can't hold back an earlier one.
export const releaseJobId = (emailId: string) => `release:${emailId}`;
/** Releases the emails `rows` yields (workspace_id, id) at `at`, or moves their waiting release there. */
export const queueRelease = (rows: SQL, at: string) => sql`INSERT INTO jobs(id,type,workspace_id,payload,available_at)
  SELECT 'release:'||r.id,'sending.release',r.workspace_id,jsonb_build_object('emailId',r.id,'run',${id('run')}::text),${at}::timestamptz FROM (${rows}) r
  ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,payload=excluded.payload,available_at=excluded.available_at,lease_until=NULL,last_error=NULL RETURNING 1`;
export const scheduledEvent = (rows: SQL, type: 'scheduled' | 'rescheduled', at: string, simulated: boolean) => sql`INSERT INTO sending_email_events(id,workspace_id,email_id,type,simulated,data) /* premerge-accepted: never (scheduled or rescheduled) */
  SELECT public.row_id('event'),r.workspace_id,r.id,${type},${simulated},jsonb_build_object('scheduledAt',${at}::text) FROM (${rows}) r RETURNING 1`;
/** A send time within the schedule's bounds (the same as send_admission's), in UTC. */
export function scheduleTime(value: string) {
  const at = Date.parse(value), now = Date.now(), { skewSeconds, horizonSeconds } = SEND_LIMITS.schedule;
  if (!(at >= now - skewSeconds * 1000 && at <= now + horizonSeconds * 1000)) throw new ApiError(422, 'INVALID_SCHEDULE', `Schedule between now and ${horizonSeconds / 86_400} days from now.`, 'scheduledAt');
  return new Date(at).toISOString();
}
// Refusals that pass on their own within minutes (the dispatch queue is full, Hosted setup is finishing): a scheduled
// send retries them every 30 seconds for up to 15 minutes past its time, then is rejected like any other refusal.
const RELEASE_WAITS = new Set(['PENDING_EMAIL_LIMIT_EXCEEDED', 'TENANT_NOT_READY']);
const RELEASE_GRACE_MS = 15 * 60_000, RELEASE_RETRY_MS = 30_000;
// A scheduled marketing email its ramp hour has no room for is held, never rejected: it goes when room opens, or once it
// has been held RAMP_HOLD_MS (it fit the step's ceiling, and a day of it, when it was scheduled), but never while the
// workspace is paused. A paused hold looks again after HOLD_RECHECK_MS to twice that and counts its RAMP_HOLD_MS again from the last
// time it found a pause.
// Held emails wake spread out, not all on the hour or in step: a workspace's whole schedule (up to 100,000) can be held,
// and each wake takes its admission lock.
const RAMP_HOLD_MS = 24 * 3_600_000, HOLD_RECHECK_MS = 30 * 60_000, HOLD_SPREAD_MS = 10 * 60_000;
const spread = (ms: number) => Math.floor(Math.random() * ms);
/**
 * The release job: at its time, a scheduled email is admitted by send_admission as a send made then, under its row lock:
 * standing and holds, the Hosted daily limit, the balance, the dispatch queue, and its region and binding resolved again.
 * Admitted, it moves scheduled -> queued with created_at now (so the hour it is charged and billed in is this one, as an
 * immediate send's) for the dispatcher. Refused, it is rejected with the refusal's code: a reject event and
 * email.rejected, nothing charged. Canceled or already released meanwhile: nothing to do; moved later: it waits.
 * Marketing its ramp hour has no room for, or that a quarantined campaign pauses (RAMP_PAUSED), is held instead
 * (RAMP_HOLD_MS): still scheduled, its scheduledAt the time it tries again, with a Waiting event (dispatch_deferred) when
 * its hold starts or changes cause. Once held, it stays held while the workspace is paused (RAMP_PAUSED, MARKETING_HELD
 * or HOSTED_SENDING_PAUSED) until the owner resumes or cancels; the dispatcher never leases a scheduled row.
 * One transaction: a crash before its commit leaves the email scheduled for the job's next attempt, after it leaves
 * nothing to redo, and the dispatcher's claim (queued -> attempting) sends it once. Its last attempt failing rejects
 * the email (endRelease) instead of leaving it waiting forever; the job runner's claim does the same when its last
 * lease runs out (jobs.ts, failScheduledRelease).
 */
export const releaseScheduled: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  const emailId = String(payload.emailId), wid = job.workspaceId;
  let outcome: Awaited<ReturnType<typeof release>>;
  try { outcome = await release(); } catch (error) {
    if (error instanceof JobDeferred || job.attempts < MAX_ATTEMPTS) throw error;
    // An email that can't be rejected now is not dropped: its release starts over, with a fresh set of attempts.
    const webhooks = await endRelease(runtime, wid, emailId, payload.run).catch(() => { throw new JobDeferred(new Date(Date.now() + 60_000).toISOString()); });
    return wakeWebhooks(runtime, webhooks);
  }
  // Held (committed with its event): its job waits, a fresh set of attempts each time (jobs.ts).
  if (outcome && 'held' in outcome) throw outcome.held;
  if (outcome?.route && !outcome.heldForScreen) {
    const { route, priority, maxSendRate } = outcome;
    try { await runtime.dispatch?.(route.region, route.connection?.aws_account_id, 1, route.connection?.kind, priority, maxSendRate); }
    catch { log('warn', { code: 'DISPATCH_WAKE_FAILED', jobId: job.id, message: 'Released mail is durable; the dispatcher polls and the scheduler pings it.' }); }
  } else if (outcome?.webhooks) await wakeWebhooks(runtime, outcome.webhooks);
  async function release() { return runtime.db.transaction(async tx => {
    // Its time by the database's clock, which the job runner's claim also reads.
    const [row] = await tx.select({ status: emails.status, scheduledAt: emails.scheduledAt, actorKeyId: emails.actorKeyId, from: emails.from, snapshot: emails.snapshot, simulated: emails.simulated,
      early: sql<boolean>`${emails.scheduledAt} > clock_timestamp()`, waits: sql<boolean>`${emails.scheduledAt} + make_interval(secs => ${RELEASE_GRACE_MS / 1000}) > clock_timestamp()` })
      .from(emails).where(and(eq(emails.workspaceId, wid), eq(emails.id, emailId))).for('update');
    if (row?.status !== 'scheduled') return null;
    if (row.early) throw new JobDeferred(row.scheduledAt!);
    const s = row.snapshot, files = [...new Set(s.attachments)], marketing = s.kind === 'marketing' || !!s.bulk;
    const mail: AdmissionMail = { host: row.from.split('@')[1]!.toLowerCase(), region: s.requestedRegion, kind: s.kind, attachments: files, bodyBytes: contentBytes(s) };
    const heldSince = typeof payload.heldSince === 'string' ? Date.parse(payload.heldSince) : null;
    // Held: it stays scheduled, at the time it tries again, and its job keeps when its RAMP_HOLD_MS started (now for a pause).
    const hold = async (code: string, until: number, data: Record<string, unknown> = {}) => {
      const at = new Date(Math.max(until, Date.now() + 1000)).toISOString(), changed = payload.heldBy !== code;
      await tx.execute(sql`WITH moved AS (UPDATE sending_emails SET scheduled_at=${at}::timestamptz,updated_at=clock_timestamp() WHERE workspace_id=${wid} AND id=${emailId} AND status='scheduled' RETURNING workspace_id,id)
        ${changed ? sql`, noted AS (INSERT INTO sending_email_events(id,workspace_id,email_id,type,simulated,data) /* premerge-accepted: never (dispatch_deferred) */
          SELECT public.row_id('event'),workspace_id,id,'dispatch_deferred',${row.simulated},${JSON.stringify({ code, providerCalled: false, until: at, ...data })}::jsonb FROM moved RETURNING 1)` : sql``} SELECT 1`);
      if (changed) log('info', { code: 'SCHEDULED_EMAIL_HELD', workspaceId: wid, emailId, reason: code, until: at });
      const since = code !== 'RAMP_LIMIT_REACHED' || heldSince === null ? new Date().toISOString() : payload.heldSince;
      return { held: new JobDeferred(at, { ...payload, heldBy: code, heldSince: since }) };
    };
    // Its sender's authority is the dispatcher's to recheck at the claim, as for any queued mail.
    const admit = async (ramped: boolean) => {
      const decision = await admission(runtime, wid, actorJson({ keyId: row.actorKeyId, domains: [] }), { stage: 'send', locks: 'take', mails: [mail],
        ...charges(runtime, [{ recipients: hostedCost(s.to, s.cc, s.bcc), marketing, ...(ramped ? { snapshot: s } : {}) }]) }, undefined, sql`${JSON.stringify(files)}::jsonb`);
      return (await tx.execute<{ s: Admitted | Refused }>(sql`SELECT ${decision} AS s`)).rows[0]!.s;
    };
    let d = await admit(true);
    // Held RAMP_HOLD_MS and still no room: it fit the step's ceiling when it was scheduled, so it goes now, past the ramp.
    if (!d.allowed && d.code === 'RAMP_LIMIT_REACHED' && heldSince !== null && Date.now() >= heldSince + RAMP_HOLD_MS) {
      log('warn', { code: 'SCHEDULED_EMAIL_RAMP_BOUND', workspaceId: wid, emailId, heldSince: payload.heldSince });
      d = await admit(false);
    }
    shadowBilling(d.billing, wid);
    if (d.allowed) {
      if (s.kind === 'marketing') {
        // Pre-upgrade scheduled snapshots carry the generated header rather than a separate origin.
        const origin = s.linkOrigin ?? s.headers.find(h => h.Name.toLowerCase() === 'list-unsubscribe')?.Value.match(/^<(https?:\/\/[^/]+)\/unsubscribe\//)?.[1];
        if (origin) {
          const n = hostedCost(s.to, s.cc, s.bcc), allowance = await linkAllowance(tx, runtime.config, wid, origin);
          // Roll back admission's charges along with the attempt, and retry the same scheduled email.
          if (allowance && n > allowance.left) throw new JobDeferred(allowance.until, payload);
          if (new URL(origin).hostname === runtime.config.linkHost) await recordLinkUse(tx, wid, runtime.config.linkHost, n);
        }
      }
      const route = d.mails[0]!;
      const needsVerdict = !s.screenVerdict && resolveHostedContentPolicy(runtime.config, {
        shared: route.connection?.kind === 'shared', from: row.from, probation: false, simulated: isSimulatedSes(runtime), kind: s.kind, screen: s.screen,
      }).screened;
      const { rows: [lim] } = await tx.execute<{ rate: number | null }>(route.connection?.aws_account_id
        ? sql`SELECT max_send_rate AS rate FROM provider_account_limits WHERE aws_account_id=${route.connection.aws_account_id} AND region=${route.region} AND max_send_rate>0`
        : sql`SELECT max_send_rate AS rate FROM sending_region_limits WHERE workspace_id=${wid} AND region=${route.region} AND max_send_rate>0`);
      await tx.execute(sql`UPDATE sending_emails SET status='queued',region=${route.region},screened=${!needsVerdict},created_at=clock_timestamp(),updated_at=clock_timestamp(),
        snapshot=(snapshot-'binding')||jsonb_build_object('region',${route.region}::text)${route.binding ? sql`||jsonb_build_object('binding',${JSON.stringify(route.binding)}::jsonb)` : sql``}
        WHERE workspace_id=${wid} AND id=${emailId} AND status='scheduled'`);
      const maxSendRate = typeof lim?.rate === 'number' && lim.rate > 0 ? lim.rate : undefined;
      return { route, priority: !marketing, maxSendRate, heldForScreen: needsVerdict };
    }
    // No room, or a quarantined campaign pauses the workspace's marketing (RAMP_PAUSED, asked before the room): held. Once
    // held, the workspace's own pauses hold it too.
    if (d.code === 'RAMP_LIMIT_REACHED') return hold(d.code, Date.parse(d.resetAt!) + spread(HOLD_SPREAD_MS));
    if (d.code === 'RAMP_PAUSED') return hold(d.code, Date.now() + HOLD_RECHECK_MS + spread(HOLD_RECHECK_MS), { campaignId: d.campaignId, pauseCode: d.pauseCode });
    if (heldSince !== null && (d.code === 'HOSTED_SENDING_PAUSED' || d.code === 'MARKETING_HELD')) return hold(d.code, Date.now() + HOLD_RECHECK_MS + spread(HOLD_RECHECK_MS));
    if (RELEASE_WAITS.has(d.code) && row.waits) throw new JobDeferred(new Date(Date.now() + RELEASE_RETRY_MS).toISOString());
    const { rows: [rejected] } = await tx.execute<{ n: number }>(sql`WITH rejected AS (UPDATE sending_emails SET status='rejected',error_code=${d.code},updated_at=clock_timestamp()
        WHERE workspace_id=${wid} AND id=${emailId} AND status='scheduled' RETURNING ${terminalColumns}
      ), ${terminalEvents(sql`SELECT * FROM rejected`, sql`'{"providerCalled":false}'::jsonb`)} SELECT count(*)::int AS n FROM webhook_jobs`);
    log('warn', { code: 'SCHEDULED_EMAIL_REFUSED', workspaceId: wid, emailId, refusal: d.code, jobId: job.id });
    return { webhooks: rejected!.n };
  }); }
});
/** A release's last attempt failed: under the email's row lock, and only while this attempt's run is still the job's (a
 * reschedule requeues it with a new one), the scheduled email is rejected with SCHEDULE_RELEASE_FAILED. Returns the
 * webhook jobs it queued. Lock order, as cancel and reschedule: the email row first, then the job read in a statement of
 * its own, so it sees a reschedule that held the row while this one waited (one statement would keep the snapshot it
 * took before the wait and judge by the old run). */
async function endRelease(runtime: Runtime, wid: string, emailId: string, run: unknown) {
  return runtime.db.transaction(async tx => {
    if (!(await tx.execute(sql`SELECT 1 FROM sending_emails WHERE workspace_id=${wid} AND id=${emailId} AND status='scheduled' FOR UPDATE`)).rows.length) return 0;
    const { rows: [job] } = await tx.execute<{ run: string | null }>(sql`SELECT payload->>'run' AS run FROM jobs WHERE id=${releaseJobId(emailId)}`);
    if ((job?.run ?? null) !== (typeof run === 'string' ? run : null)) return 0;
    const { rows: [ended] } = await tx.execute<{ n: number }>(sql`WITH ${failScheduledRelease(sql`SELECT ${wid}::text AS workspace_id,${emailId}::text AS id`)} SELECT count(*)::int AS n FROM webhook_jobs`);
    log('warn', { code: 'SCHEDULE_RELEASE_FAILED', workspaceId: wid, emailId });
    return ended!.n;
  });
}
