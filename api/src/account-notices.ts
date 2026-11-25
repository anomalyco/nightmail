import { sql, type SQL } from 'drizzle-orm';
import { ApiError, id, isSimulatedSes, log, ModuleLoadError, type DbExecutor, type JobHandler, type Runtime } from './core.js';
import { JobDeferred, MAX_ATTEMPTS, retryDatabaseFailures } from './jobs.js';
import { RATES } from './billing/money.js';
import { SEND_LIMITS } from './send-limits.js';
import { customerNotice, plainAddress, type Notice, type NoticeInput } from './notices.js';
import { LINK_MINUTES, signinLinkUrl } from './signups.js';

// Sending the account emails (src/notices.ts writes them). Three jobs send one each, every one through deliverNotice:
// standing.notify (standing.ts: paused, marketing on hold, warning, resumed, campaign paused), billing.notify
// (billing/notify.ts) and account.notify here, for the moments that have no standing event or billing notice of their
// own: a domain that stopped verifying or was released, a new domain's records still missing after an hour and a new workspace with no
// domain after an hour (src/domain-setup.ts), the daily limit reached, the evaluation finished, an invitation, the waitlist and a sign-in link. Those are account_notices rows (migration 403), one per dedupe key, queued with their job in one statement.
//
// An email goes out once: the row's dedupe key makes one notice of one moment, the job leases the row so one runner
// sends it, and the send's idempotency key (its origin) makes a retried send the same email. Nothing here runs in the
// request or job that found the moment, except the one INSERT, and that never fails its caller (queueNotice).

type Origin = { standingEvent: string } | { billingNotice: string } | { notice: string };
const keyOf = (origin: Origin) => 'standingEvent' in origin ? `standing:${origin.standingEvent}` : 'billingNotice' in origin ? `billing:${origin.billingNotice}` : `notice:${origin.notice}`;

/**
 * One notice to its recipients, from the platform workspace's own sender (NIGHTMAIL_NOTIFY_FROM), one email each.
 * 'unconfigured' when the installation has no such sender: the dashboard still shows what the email would have said.
 * `sealed`: the email carries a capability only its recipient may use (a sign-in link), so the platform workspace's own
 * readers see it withheld (sending.ts visibleEmailContent).
 */
export async function deliverNotice(runtime: Runtime, to: string[], notice: Notice, origin: Origin, sealed = false): Promise<'sent' | 'unconfigured'> {
  const from = runtime.config.notifyFrom, sender = runtime.config.platformDomainWorkspace;
  if (!from || !sender || !runtime.config.multiTenant) return 'unconfigured';
  const { sendSystemEmail } = await import('./sending.js');
  try { await sendSystemEmail(runtime, sender, { from, to, ...notice, idempotencyKey: keyOf(origin), ...origin, sealed }); }
  catch (error) {
    // The key was used with other words: a build before this one sent this notice and its job is being retried.
    if (!(error instanceof ApiError && error.code === 'IDEMPOTENCY_CONFLICT')) throw error;
    log('info', { code: 'NOTICE_ALREADY_SENT', origin: keyOf(origin) });
  }
  return 'sent';
}

// A notice row is leased while its job sends it. A send that fails must not end there: the job's next attempt would find
// the row leased, and a job that returned would be done with the email unsent. So a job that finds its row leased waits
// for the lease to end (heldNotice), and a send that throws gives the lease back at once (noticeFailed), so the runner's
// retries send it. Every attempt sends under the row's key, so however many run, one email goes out.
type NoticeTable = 'account_notices' | 'billing_notices';
/**
 * For a job whose lease found nothing to take: if a run still holds the row (it crashed, or could not give the lease
 * back), come back when its lease ends, without spending an attempt. Otherwise the notice is settled and the job is done.
 */
export async function heldNotice(db: DbExecutor, table: NoticeTable, noticeId: string) {
  const { rows: [held] } = await db.execute<{ seconds: number }>(sql`SELECT extract(epoch FROM lease_until-now())::float AS seconds FROM ${sql.identifier(table)} WHERE id=${noticeId} AND status='sending' AND lease_until>now()`);
  if (held) throw new JobDeferred(new Date(Date.now() + Math.ceil(held.seconds * 1000) + 1000).toISOString(), undefined, true);
}
/**
 * A send that threw. While the runner will try again the row goes back to pending; on the last attempt (the error is not
 * retryable, or the attempts are used) it is settled failed and logged as an error, so an email nobody got is visible.
 */
export async function noticeFailed(runtime: Runtime, table: NoticeTable, noticeId: string, job: { attempts: number; workspaceId: string }, error: unknown, kind: string) {
  const retryable = !(error instanceof ApiError) || error.retryable;
  const last = !(error instanceof ModuleLoadError) && (!retryable || job.attempts >= MAX_ATTEMPTS);
  await runtime.db.execute(sql`UPDATE ${sql.identifier(table)} SET status=${last ? 'failed' : 'pending'},lease_until=NULL WHERE id=${noticeId} AND status='sending'`).catch(() => {});
  if (last) log('error', { code: 'NOTICE_SEND_FAILED', workspaceId: job.workspaceId, notice: table === 'billing_notices' ? 'billing' : 'account', kind, noticeId, attempts: job.attempts, error: error instanceof ApiError ? error.code : 'JOB_INTERNAL_ERROR' });
}

/** A workspace's owners and admins with a verified address, at most 20: who an account email goes to. */
export const noticeRecipients = (workspace: SQL) => sql`ARRAY(SELECT u.email FROM workspace_members m JOIN nightmail_users u ON u.id=m.user_id
  WHERE m.workspace_id=${workspace} AND m.role IN ('owner','admin') AND u.email_verified ORDER BY u.email LIMIT 20)`;

export type AccountNoticeKind = 'domain_unverified' | 'domain_released' | 'domain_setup' | 'no_domain' | 'limit_reached' | 'evaluation_finished' | 'invitation' | 'waitlist_admitted' | 'signin_link';
type Queued = { workspaceId: string; kind: AccountNoticeKind; dedupe: string; data?: Record<string, unknown>;
  /** At most one of this kind per workspace in 24 hours (suppressed ones don't count). */
  daily?: boolean;
  /** Queue it only while this holds, in the same statement. */
  when?: SQL };
/** The notice row and its job, in one statement. Returns a row when this call made the notice. */
export const noticeInsert = (n: Queued) => sql`WITH made AS (INSERT INTO account_notices(id,workspace_id,kind,dedupe_key,data)
    SELECT ${id('ant')},${n.workspaceId},${n.kind},${n.dedupe},${JSON.stringify(n.data ?? {})}::jsonb
    WHERE ${n.when ?? sql`true`} AND ${n.daily ? sql`NOT EXISTS (SELECT FROM account_notices p WHERE p.workspace_id=${n.workspaceId} AND p.kind=${n.kind} AND p.status<>'suppressed' AND p.created_at>now()-interval '24 hours')` : sql`true`}
    ON CONFLICT (dedupe_key) DO NOTHING RETURNING id,workspace_id),
  queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'account.notify:'||id,'account.notify',workspace_id,jsonb_build_object('noticeId',id) FROM made ON CONFLICT (id) DO NOTHING)
  SELECT id FROM made`;
/**
 * Queues a notice without ever failing the caller: a notice that can't be queued is logged, and what it reports goes
 * on. Inside a transaction pass `savepoint`, so a failed insert leaves the transaction usable.
 */
export async function queueNotice(db: DbExecutor, n: Queued, savepoint = false): Promise<boolean> {
  try {
    if (savepoint) await db.execute(sql`SAVEPOINT account_notice`);
    const { rows } = await db.execute(noticeInsert(n));
    if (savepoint) await db.execute(sql`RELEASE SAVEPOINT account_notice`);
    return rows.length > 0;
  } catch {
    if (savepoint) await db.execute(sql`ROLLBACK TO SAVEPOINT account_notice`).catch(() => {});
    log('warn', { code: 'NOTICE_NOT_QUEUED', workspaceId: n.workspaceId, kind: n.kind });
    return false;
  }
}

/** A domain whose grace ran out: mail from it is refused from now on. Once per loss (the claim's lost_since). */
export const domainUnverified = (db: DbExecutor, workspaceId: string, domain: { id: string; name: string; lostSince: string | null }) =>
  queueNotice(db, { workspaceId, kind: 'domain_unverified', dedupe: `domain:${domain.id}:${domain.lostSince ?? ''}`, data: { domainId: domain.id, name: domain.name } }, true);

/** A proven domain released because its ownership records were gone for 30 days (operations.ts expireDomainClaims). Once per claim. */
export const domainReleased = (db: DbExecutor, workspaceId: string, domain: { name: string; token: string }) =>
  queueNotice(db, { workspaceId, kind: 'domain_released', dedupe: `domain-released:${domain.token}`, data: { name: domain.name } }, true);

/** What the setup reminder says (src/domain-setup.ts builds it from the background DNS check). */
export type DomainSetupData = { domainId: string; name: string; /** Nobody serves DNS for it (record-check.ts dnsZone). */ noDns?: boolean; /** A wildcard (and the parking host behind it) answering its missing CNAMEs (record-check.ts wildcardOf). */ wildcard?: string; parking?: { owner: string; target: string }; total: number; wrong: boolean; missing: { type: string; name: string; value: string }[]; host: { name: string; url: string | null } | null; releasesAt: string | null };
/**
 * A domain still pending an hour after it was added, whose records public DNS lacks: once per domain (its claim's token),
 * and at most one a day per workspace, so a workspace that added several hears about one at a time. Queued only while the
 * claim is pending (its ownership TXT may be proven while a DKIM CNAME is missing); one that verifies before the email
 * goes is not told (noticeOf).
 */
export const domainSetup = (db: DbExecutor, workspaceId: string, token: string, data: DomainSetupData) =>
  queueNotice(db, { workspaceId, kind: 'domain_setup', dedupe: `domain-setup:${token}`, data, daily: true,
    when: sql`EXISTS (SELECT FROM domain_claims WHERE workspace_id=${workspaceId} AND token=${token}::uuid AND sending_state='pending')` });

/**
 * New workspaces that still have no domain an hour after they were created, each told once (its dedupe key): one
 * statement, at most 100 at a time, for workspaces created in the last three days only, so turning the reminder on never
 * mails accounts that signed up long ago. The platform's own workspace is never one. One that adds a domain before the
 * email goes is not told (noticeOf). Returns how many were queued.
 */
export async function noDomainNotices(runtime: Runtime) {
  const { rows } = await runtime.db.execute(sql`WITH made AS (INSERT INTO account_notices(id,workspace_id,kind,dedupe_key,data)
      SELECT 'ant_'||replace(gen_random_uuid()::text,'-',''),w.id,'no_domain','no-domain:'||w.id,'{}'::jsonb FROM workspaces w
      WHERE w.created_at<=now()-interval '1 hour' AND w.created_at>now()-interval '3 days' AND w.id IS DISTINCT FROM ${runtime.config.platformDomainWorkspace ?? null}
        AND NOT EXISTS (SELECT FROM domain_claims dc WHERE dc.workspace_id=w.id AND NOT coalesce(dc.identity ? 'builtin',false)) AND NOT EXISTS (SELECT FROM account_notices p WHERE p.dedupe_key='no-domain:'||w.id)
      ORDER BY w.created_at LIMIT 100
      ON CONFLICT (dedupe_key) DO NOTHING RETURNING id,workspace_id),
    queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'account.notify:'||id,'account.notify',workspace_id,jsonb_build_object('noticeId',id) FROM made ON CONFLICT (id) DO NOTHING)
    SELECT id FROM made`);
  return rows.length;
}

/**
 * A send refused at the daily limit: at most one email in 24 hours, and none for a workspace in its evaluation, paused,
 * or exempt from limits. One statement per refused request, which writes nothing once the day's notice exists.
 */
export async function limitReached(runtime: Runtime, workspaceId: string) {
  if (!runtime.config.multiTenant) return;
  await queueNotice(runtime.db, { workspaceId, kind: 'limit_reached', dedupe: `limit:${workspaceId}:${new Date().toISOString().slice(0, 10)}`, daily: true,
    when: sql`EXISTS (SELECT FROM sender_standing s JOIN workspaces w ON w.id=s.workspace_id JOIN provider_connections pc ON pc.workspace_id=s.workspace_id AND pc.kind='shared'
      WHERE s.workspace_id=${workspaceId} AND s.phase='graded' AND s.daily_limit IS NOT NULL AND NOT w.exempt_hosted_quotas AND pc.paused_at IS NULL)` });
}

/** The evaluation's end, once in a workspace's life. */
export const evaluationFinished = (db: DbExecutor, workspaceId: string, limited: boolean) =>
  queueNotice(db, { workspaceId, kind: 'evaluation_finished', dedupe: `evaluation:${workspaceId}`, data: { limited } });

/**
 * Invitation emails a workspace may cause in a UTC day, one address may get from every workspace together in a day, and
 * one workspace may send one address in all (pair): revoking and inviting again mails nobody a fourth time. Only that
 * address accepting an invitation starts the count again.
 */
export const INVITATION_EMAILS = { workspaceDay: 20, addressDay: 5, pair: 3 } as const;
const budget = (db: DbExecutor, workspace: string, key: string, limit: number) => db.execute(sql`INSERT INTO api_request_budgets AS b(workspace_id,key_id,window_start,used) VALUES(${workspace},${key},date_trunc('day',now()),1)
  ON CONFLICT(workspace_id,key_id) DO UPDATE SET used=CASE WHEN b.window_start=excluded.window_start THEN b.used+1 ELSE 1 END,window_start=excluded.window_start
  WHERE b.window_start<>excluded.window_start OR b.used<${limit} RETURNING 1`).then(r => r.rows.length > 0);
/** Why an invitation was not emailed: nothing here sends one, the workspace is not yet one that may, or an allowance is used. */
export type InvitationNotEmailed = 'not_available' | 'new_workspace' | 'allowance_used';
/**
 * The invitation's email, queued in the transaction that made the invitation. Null when it is queued, otherwise why
 * none goes out (the inviter then shares the link): the installation has no sender for it or the inviter no verified
 * plain address to be named by; the workspace has neither a verified domain nor finished its evaluation (an email from
 * this installation's own address to any address is not for an account that signed up a minute ago); or an allowance
 * is used. The order matters: a workspace that may not email spends no allowance.
 */
export async function inviteByEmail(runtime: Runtime, tx: DbExecutor, invitation: { id: string; workspaceId: string; email: string }, inviterId: string, addressHash: string): Promise<InvitationNotEmailed | null> {
  if (!runtime.config.multiTenant || !runtime.config.notifyFrom || !runtime.config.platformDomainWorkspace) return 'not_available';
  try {
    await tx.execute(sql`SAVEPOINT invitation_email`);
    const { rows: [may] } = await tx.execute<{ inviter: string | null; established: boolean }>(sql`SELECT (SELECT u.email FROM nightmail_users u WHERE u.id=${inviterId} AND u.email_verified) AS inviter,
      EXISTS (SELECT FROM domain_claims dc WHERE dc.workspace_id=${invitation.workspaceId} AND dc.sending_state='verified')
        OR EXISTS (SELECT FROM sender_standing s WHERE s.workspace_id=${invitation.workspaceId} AND s.phase='graded') AS established`);
    const refused = !may?.inviter || !plainAddress(may.inviter) ? 'not_available' : !may.established ? 'new_workspace' : null;
    if (refused) { await tx.execute(sql`RELEASE SAVEPOINT invitation_email`); return refused; }
    const queued = await budget(tx, invitation.workspaceId, 'invitation-email', INVITATION_EMAILS.workspaceDay) && await budget(tx, 'global', `invitation-email:${addressHash}`, INVITATION_EMAILS.addressDay)
      && (await tx.execute(noticeInsert({ workspaceId: invitation.workspaceId, kind: 'invitation', dedupe: `invitation:${invitation.id}`, data: { invitationId: invitation.id, address: addressHash },
        // The address is kept as its hash; a notice that was never sent (revoked first, or failed) does not count.
        when: sql`(SELECT count(*) FROM account_notices p WHERE p.workspace_id=${invitation.workspaceId} AND p.kind='invitation' AND p.data->>'address'=${addressHash} AND p.status IN ('pending','sending','sent')
          AND p.created_at>coalesce((SELECT max(i.created_at) FROM workspace_invitations i WHERE i.workspace_id=${invitation.workspaceId} AND i.email=${invitation.email} AND i.status='accepted'),'-infinity'))<${INVITATION_EMAILS.pair}` }))).rows.length > 0;
    await tx.execute(queued ? sql`RELEASE SAVEPOINT invitation_email` : sql`ROLLBACK TO SAVEPOINT invitation_email`);
    return queued ? null : 'allowance_used';
  } catch {
    await tx.execute(sql`ROLLBACK TO SAVEPOINT invitation_email`).catch(() => {});
    log('warn', { code: 'NOTICE_NOT_QUEUED', workspaceId: invitation.workspaceId, kind: 'invitation' });
    return 'not_available';
  }
}

/**
 * The email to a waitlisted address that was let in, once per address: signups.ts placesOpened calls it for each address
 * a raise of the sign-up limit holds a place for. The notice is recorded under the platform workspace.
 */
export async function waitlistAdmitted(runtime: Runtime, db: DbExecutor, email: string) {
  const workspaceId = runtime.config.platformDomainWorkspace;
  return !!workspaceId && queueNotice(db, { workspaceId, kind: 'waitlist_admitted', dedupe: `waitlist:${email.toLowerCase()}`, data: { email: email.toLowerCase() } });
}
/** The status of a waitlist address's email (null: none queued), for a lowercased address column. */
export const waitlistNoticeStatus = (email: SQL) => sql`(SELECT n.status FROM account_notices n WHERE n.dedupe_key='waitlist:'||${email})`;

/** A sign-in link's email (signups.ts sendSigninLink), queued in the transaction that made the link. Only the link's ID
 * is kept: the job makes the link from it, and sends nothing once it is used or expired. */
export const signinLink = (workspaceId: string, linkId: string) => noticeInsert({ workspaceId, kind: 'signin_link', dedupe: `signin-link:${linkId}`, data: { linkId } });

type Row = { id: string; kind: AccountNoticeKind; data: Record<string, unknown>; name: string | null; exempt: boolean | null; recipients: string[];
  standing: { phase: string; step: string; daily: number | null } | null; paused: boolean | null; position: { mode?: string; enforcement?: string; availableUc?: string; freeSentLeft?: number } | null;
  domain: string | null; hasDomain: boolean | null; builtin: string | null; invitation: { email: string; role: 'owner' | 'admin' | 'member'; expiresAt: string; inviterEmail: string } | null; link: { email: string } | null };

/** What the row says now, or null when the moment has passed (fixed, revoked, or told by a more serious email). */
function noticeOf(row: Row, origin: string, config: Runtime['config']): { to: string[]; input: NoticeInput } | null {
  const workspace = row.name ?? '', held = !!row.paused || (row.standing !== null && ['warn', 'restrict', 'pause'].includes(row.standing.step));
  switch (row.kind) {
    // Still refused: a domain that verified again, or was removed, needs no email.
    case 'domain_unverified': return row.domain === 'pending' || row.domain === 'failed' ? { to: row.recipients, input: { kind: 'domain_unverified', workspace, domain: { id: String(row.data.domainId), name: String(row.data.name) } } } : null;
    // Not added again meanwhile: a workspace that already has the domain back needs no email about losing it.
    case 'domain_released': return row.domain === null ? { to: row.recipients, input: { kind: 'domain_released', workspace, domain: { name: String(row.data.name) } } } : null;
    // Still pending: one that verified meanwhile, or was removed, needs no reminder.
    case 'domain_setup': {
      const d = row.data as DomainSetupData;
      return row.domain === 'pending' && Array.isArray(d.missing) && (d.missing.length || d.noDns === true) ? { to: row.recipients, input: { kind: 'domain_setup', workspace, domain: { id: String(d.domainId), name: String(d.name) },
        noDns: d.noDns === true, ...(typeof d.wildcard === 'string' ? { wildcard: d.wildcard, ...(d.parking && typeof d.parking.owner === 'string' && typeof d.parking.target === 'string' ? { parking: d.parking } : {}) } : {}), missing: d.missing, total: Number(d.total), wrong: d.wrong === true, host: d.host ?? null, releasesAt: d.releasesAt ? new Date(d.releasesAt) : null } } : null;
    }
    // Still no domain: one added meanwhile, in any state, needs no email.
    case 'no_domain': return row.hasDomain ? null : { to: row.recipients, input: { kind: 'no_domain', workspace,
      builtin: row.builtin && config.multiTenant && config.builtinDomain ? { name: row.builtin, scope: config.builtinScope, perDay: SEND_LIMITS.builtin[config.builtinScope].perDay } : null } };
    case 'limit_reached': {
      const p = row.position ?? {}, available = BigInt(p.availableUc ?? '0');
      const unpaid = p.enforcement === 'enforce' && p.mode === 'prepaid' && (available < 0n || (available < RATES.emailUc && (p.freeSentLeft ?? 0) === 0));
      return row.exempt || row.paused || unpaid || row.standing?.phase !== 'graded' || row.standing.daily === null ? null : { to: row.recipients, input: { kind: 'limit_reached', workspace } };
    }
    // A workspace that left its evaluation into a warning, a hold or a pause is told that instead.
    case 'evaluation_finished': return row.exempt || held ? null : { to: row.recipients, input: { kind: 'evaluation_finished', workspace, limited: row.data.limited === true } };
    case 'invitation': {
      const i = row.invitation;
      return i && { to: [i.email], input: { kind: 'invitation', inviter: { email: i.inviterEmail }, role: i.role, expiresAt: new Date(i.expiresAt),
        acceptUrl: `${origin}/overview?invitation=${encodeURIComponent(String(row.data.invitationId))}` } };
    }
    case 'waitlist_admitted': return typeof row.data.email === 'string' ? { to: [row.data.email], input: { kind: 'waitlist_admitted' } } : null;
    // Used or expired before it went out: nothing to send.
    case 'signin_link': return row.link && { to: [row.link.email], input: { kind: 'signin_link', url: signinLinkUrl(config, String(row.data.linkId)), minutes: LINK_MINUTES } };
  }
}

export const accountNotifyJob: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  const noticeId = typeof payload.noticeId === 'string' ? payload.noticeId : '';
  // The lease: one runner at a time. A send that failed or crashed is sent by a later attempt, under the same key.
  const { rows: [row] } = await runtime.db.execute<Row>(sql`WITH leased AS (
      UPDATE account_notices SET status='sending',lease_until=now()+interval '5 minutes'
      WHERE id=${noticeId} AND workspace_id=${job.workspaceId} AND (status='pending' OR (status='sending' AND lease_until<now())) RETURNING id,kind,data,workspace_id)
    SELECT l.id,l.kind,l.data,w.name,w.exempt_hosted_quotas AS exempt,${noticeRecipients(sql`l.workspace_id`)} AS recipients,
      (SELECT json_build_object('phase',s.phase,'step',s.step,'daily',s.daily_limit) FROM sender_standing s WHERE s.workspace_id=l.workspace_id) AS standing,
      (SELECT pc.paused_at IS NOT NULL FROM provider_connections pc WHERE pc.workspace_id=l.workspace_id AND pc.kind='shared') AS paused,
      CASE WHEN l.kind='limit_reached' THEN billing_position(l.workspace_id) END AS position,
      (SELECT dc.sending_state FROM domain_claims dc WHERE dc.workspace_id=l.workspace_id AND dc.name=l.data->>'name') AS domain,
      CASE WHEN l.kind='no_domain' THEN EXISTS (SELECT FROM domain_claims dc WHERE dc.workspace_id=l.workspace_id AND NOT coalesce(dc.identity ? 'builtin',false)) END AS "hasDomain",
      CASE WHEN l.kind='no_domain' THEN (SELECT b.name FROM builtin_domains b WHERE b.workspace_id=l.workspace_id AND b.revoked_at IS NULL) END AS builtin,
      (SELECT json_build_object('email',i.email,'role',i.role,'expiresAt',i.expires_at,'inviterEmail',u.email) FROM workspace_invitations i JOIN nightmail_users u ON u.id=i.inviter_id
        WHERE i.id=l.data->>'invitationId' AND i.workspace_id=l.workspace_id AND i.status='pending' AND i.expires_at>now()) AS invitation,
      (SELECT json_build_object('email',sl.email) FROM nightmail_signin_links sl WHERE l.kind='signin_link' AND sl.id=l.data->>'linkId' AND sl.expires_at>now()) AS link
    FROM leased l LEFT JOIN workspaces w ON w.id=l.workspace_id`);
  if (!row) return heldNotice(runtime.db, 'account_notices', noticeId);
  const settle = (status: 'sent' | 'suppressed' | 'failed') => runtime.db.execute(sql`UPDATE account_notices SET status=${status},lease_until=NULL,sent_at=CASE WHEN ${status}='sent' THEN now() END WHERE id=${row.id} AND status='sending'`);
  try {
    const notice = noticeOf(row, runtime.config.publicUrl.replace(/\/$/, ''), runtime.config);
    if (!notice) { await settle('suppressed'); log('info', { code: 'ACCOUNT_NOTICE_SUPPRESSED', workspaceId: job.workspaceId, kind: row.kind }); return; }
    if (!notice.to.length) { await settle('failed'); log('warn', { code: 'ACCOUNT_NOTIFY_NO_RECIPIENTS', workspaceId: job.workspaceId, kind: row.kind }); return; }
    if (await deliverNotice(runtime, notice.to, customerNotice(runtime.config.publicUrl, notice.input), { notice: row.id }, row.kind === 'signin_link') === 'unconfigured') {
      await settle('failed');
      log('info', { code: 'ACCOUNT_NOTIFY_SKIPPED', workspaceId: job.workspaceId, kind: row.kind, reason: 'NIGHTMAIL_NOTIFY_FROM or the platform workspace is not configured' });
      return;
    }
    await settle('sent');
    log('info', { code: 'ACCOUNT_NOTIFIED', workspaceId: job.workspaceId, kind: row.kind, recipients: notice.to.length, simulated: isSimulatedSes(runtime) });
  } catch (error) { await noticeFailed(runtime, 'account_notices', row.id, job, error, row.kind); throw error; }
});
export const accountNoticeJobs: Record<string, JobHandler> = { 'account.notify': accountNotifyJob };
