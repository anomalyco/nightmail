import { EMAIL_OUTCOME_BITS } from '../email-outcomes.js';
import { sql, type SQL, and, eq } from 'drizzle-orm';
import { apiKeys } from '../db/core.js';
import { receivingPolicy } from '../mailbox-ingest-input.js';
import { mergeSuppression } from '../db/audience.js';
import { rowId } from '../core/http.js';
import type { DbExecutor, Runtime } from '../core/types.js';
import { senderDomainAllowed } from '../core/access.js';
import { wrapModuleLoad } from '../core/errors.js';
import { simulatedTopic, isSimulatedSes } from '../core/ses.js';
import { log } from '../log.js';
import { operationWebhookFanoutCtes, simulatedFeedbackCtes } from '../states.js';
import { mailboxKeys, mailboxAddresses } from '../db/mailbox.js';
import type { EmailStatus, emailEvents, EmailSnapshot, attachments } from '../db/sending.js';
import { withRedactedReply } from '../deliverability.js';
import { now } from './schemas.js';
import { validateAttachmentRows, distinctAttachmentIds } from './mime.js';

export const FEEDBACK_LAG_HOLD_MS = 5 * 60_000;
export const FEEDBACK_LAG_FRESH_MS = 5 * 60_000;
export const FEEDBACK_LAG_DISPLAY_MS = 2 * 60_000;
/** Minimum queue backlogCount required before queue-level metrics() oldestMessageTimestamp counts as lane lag,
 *  so a handful of poison/unmatchable messages sitting in Cloudflare retry backoff never trip an installation-wide hold. */
export const FEEDBACK_LAG_MIN_DEPTH = 10;
export type FeedbackLag = { oldestMs: number; lane: 'routine' | 'priority' };

/** Persist the latest feedback queue lag sample (single-row upsert, called from minute cron and throttled on backlog). */
export async function recordFeedbackLag(db: DbExecutor, lane: 'routine' | 'priority', depth: number, oldestMs: number) {
  const safeDepth = Math.max(0, Math.round(depth)), safeOldest = Math.max(0, Math.round(oldestMs));
  await db.execute(sql`INSERT INTO operation_feedback_lag(lane, depth, oldest_ms, updated_at) VALUES (${lane}, ${safeDepth}, ${safeOldest}, now())
    ON CONFLICT (lane) DO UPDATE SET depth = excluded.depth, oldest_ms = excluded.oldest_ms, updated_at = now()`);
}
export async function activeFeedbackLag(db: DbExecutor): Promise<FeedbackLag | null> {
  const { rows: [row] } = await db.execute<{ lane: 'routine' | 'priority'; oldest_ms: number }>(sql`
    SELECT lane, oldest_ms FROM operation_feedback_lag
    WHERE updated_at > now() - make_interval(secs => ${Math.round(FEEDBACK_LAG_FRESH_MS / 1000)}::int)
      AND oldest_ms >= ${FEEDBACK_LAG_DISPLAY_MS}
    ORDER BY oldest_ms DESC, (lane = 'priority') DESC LIMIT 1`);
  return row ? { lane: row.lane, oldestMs: Number(row.oldest_ms) } : null;
}

// validation_suppressed is an SES Bounce with bounceSubType EmailValidationSuppressed: SES Auto Validation dropped the
// recipient before sending, so it is not a delivery bounce (AWS excludes it from Reputation.BounceRate). The email becomes
// suppressed rather than bounced, and its public email.bounced event carries no bounced outcome (migration 034).
// It drops one recipient, so it ranks below any outcome SES reports for a recipient it did send to: on a multi-recipient
// email a delivery, hard bounce or complaint wins in either arrival order. Migration 153 enforces this ranking and the
// EMAIL_VALIDATION_SUPPRESSED error code (kept only while suppressed, never over an earlier error) in the database, so a
// Worker still running an older rank table during a deploy cannot restore 'suppressed' or skip a delivery either.
export const statusForEvent: Record<string, EmailStatus> = { send: 'sent', delivery: 'delivered', bounce: 'bounced', non_permanent_bounce: 'delayed', validation_suppressed: 'suppressed', complaint: 'complained', complaint_feedback: 'accepted', reject: 'rejected', rendering_failure: 'rendering_failed', delivery_delay: 'delayed', accepted: 'accepted', suppressed: 'suppressed', acceptance_unknown: 'acceptance_unknown', simulated: 'simulated' };
// Publish email.sent from the SendEmail response; a later SES Send is status feedback only.
export const publicEventType: Record<string, string> = { accepted: 'email.sent', delivery: 'email.delivered', bounce: 'email.bounced', non_permanent_bounce: 'email.bounced', validation_suppressed: 'email.bounced', complaint: 'email.complained', reject: 'email.rejected', acceptance_unknown: 'email.rejected', rendering_failure: 'email.rendering_failed', delivery_delay: 'email.delivery_delayed', open: 'email.opened', click: 'email.clicked' };
export const rank: Record<EmailStatus, number> = { scheduled: 0, queued: 0, attempting: 10, acceptance_unknown: 20, accepted: 30, sent: 40, delayed: 45, suppressed: 50, delivered: 60, bounced: 70, complained: 80, rejected: 70, rendering_failed: 70, canceled: 70, simulated: 70 };
// Every outcome after a send implies it was accepted. Migration 407's check_sending_event_outcome_bits expects the same.
const { accepted: ACCEPTED_BIT, delivered: DELIVERED_BIT, bounced: BOUNCED_BIT, complained: COMPLAINED_BIT, delayed: DELAYED_BIT } = EMAIL_OUTCOME_BITS;
const outcomeBitForEvent: Record<string, number> = { send: ACCEPTED_BIT, accepted: ACCEPTED_BIT, delivery: ACCEPTED_BIT | DELIVERED_BIT, bounce: ACCEPTED_BIT | BOUNCED_BIT, non_permanent_bounce: ACCEPTED_BIT | DELAYED_BIT,
  complaint: ACCEPTED_BIT | COMPLAINED_BIT, delivery_delay: ACCEPTED_BIT | DELAYED_BIT, open: EMAIL_OUTCOME_BITS.opened, click: EMAIL_OUTCOME_BITS.clicked, reject: EMAIL_OUTCOME_BITS.failed, rendering_failure: EMAIL_OUTCOME_BITS.failed };
type EmailEventInput = { workspaceId: string; type: string; providerId?: string; errorCode?: string; data?: Record<string, unknown>; recipientHashes?: string[]; externalId?: string; createdAt?: string; receipt?: { topicArn: string; messageId: string } };
type IncomingReceipt = { topicArn: string; messageId: string; region: string; payload: Record<string, unknown>; recoveryType?: 'operation.ses' | 'operation.simulatedFeedbackRecovery' };
export async function recordEmailEvent(runtime: Runtime, input: EmailEventInput & { emailId: string }) {
  const { event, runnable } = await persistEmailEvent(runtime, input);
  if (runnable) try { await runtime.wake?.(runnable,'webhook'); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Webhook jobs remain durable.' }); }
  return event;
}
// Only authenticated ingress and the guarded test-only callback handler use this.
export async function ingestRoutineSesEvent(runtime: Runtime, input: RoutineIngress) {
  const result = (await ingestRoutineSesEvents(runtime, [input]))[0]!;
  if (!result.error && input.type !== 'receipt') log('info', { code: 'SES_FEEDBACK_INGESTED', workspaceId: result.workspaceId,
    kind: input.type === 'send' ? 'Send' : 'Delivery', outcome: result.event ? 'processed' : result.runnable > 0 ? 'deferred' : 'duplicate', runnable: result.runnable });
  return result;
}
/** An email event's data as its webhook carries it (the published event and each delivery's payload): the receiving
 *  server's reply with its addresses and IP addresses replaced, cut at 160 characters (withRedactedReply). An email
 *  webhook carried no recipient address before the reply, and giving the whole reply later would be an addition where
 *  taking it back would be a break. The email's own events keep the reply as stored. Undefined when the data has no
 *  reply: the webhook then carries the event's data. */
const webhookData = (data: Record<string, unknown> | undefined) => typeof data?.diagnosticCode === 'string' ? withRedactedReply(data) : undefined;
export type RoutineIngress = Omit<EmailEventInput, 'workspaceId'> & { workspaceId?: string; providerId: string; taggedEmailId?: string; ingress: IncomingReceipt;
  effects?: { reported: (string | null)[] | null; suppress: string | null; observe: string | null; receiptTime: boolean } };
// One statement persists verified callbacks and their side effects. Only subscriptions and
// non-routine callbacks deliberately deferred by HTTP ingress merely open their receipt.
// Early callbacks with a known owner keep a recovery job; unresolved owners return an error for redelivery.
export async function ingestRoutineSesEvents(runtime: Runtime, inputs: RoutineIngress[]) {
  if (!inputs.length) return [];
  const mx = runtime.config.multiTenant;
  const effects = inputs.some(input => input.effects);
  const topicMatch = mx ? sql`AND (x.simulated OR (e.feedback_topic_arn=x.topic_arn AND EXISTS(SELECT FROM provider_feedback_history h WHERE h.topic_arn=x.topic_arn AND h.region=x.region AND h.aws_account_id=split_part(x.topic_arn,':',5))))` : sql``;
  const rows = inputs.map((input, index) => ({
    ordinal: index, job_workspace: input.workspaceId, simulated: simulatedTopic(input.ingress.topicArn, input.ingress.region), topic_arn: input.ingress.topicArn, message_id: input.ingress.messageId, region: input.ingress.region, provider_id: input.providerId,
    type: input.type, next_status: statusForEvent[input.type]!, next_rank: rank[statusForEvent[input.type]!], public_type: publicEventType[input.type] ?? null, outcome_bit: outcomeBitForEvent[input.type] ?? 0,
    external_id: input.externalId ?? null, data: input.data ?? {}, public_data: webhookData(input.data), effects: input.effects, created_at: input.createdAt ?? now(),
    event_id: rowId('event'), recovery_job_id: rowId('job'), recovery_type: input.ingress.recoveryType, payload: input.ingress.payload, tagged_email_id: input.taggedEmailId ?? null,
  }));
  // Remove embedded NUL without changing literal backslash-u text (consume JSON escapes in pairs).
  const json=JSON.stringify(rows), safe=json.includes('\\u0000') ? json.replace(/\\(?:u0000|.)/g,m=>m==='\\u0000'?'\uFFFD':m) : json;
  const result = await runtime.db.execute<{ ordinal: number; workspaceId: string | null; error: string | null; event: typeof emailEvents.$inferSelect | null; runnable: number; recovery:boolean; hooks:number }>(sql`WITH raw AS (
      SELECT * FROM jsonb_to_recordset(${safe}::jsonb) AS x(ordinal int, job_workspace text, simulated boolean, topic_arn text, message_id text, region text, provider_id text,
        type text, next_status text, next_rank int, public_type text, outcome_bit int, external_id text, data jsonb, public_data jsonb, effects jsonb, created_at timestamptz, event_id text, recovery_job_id text, recovery_type text, payload jsonb, tagged_email_id text)
    ), candidates AS (
      SELECT x.ordinal, e.id FROM raw x JOIN sending_emails e ON e.provider_id = x.provider_id
      WHERE x.tagged_email_id IS NULL AND e.region = x.region AND e.simulated = x.simulated ${topicMatch}
        AND (x.job_workspace IS NULL OR e.workspace_id = x.job_workspace)
      UNION ALL
      SELECT x.ordinal, e.id FROM raw x JOIN sending_emails e ON e.id = x.tagged_email_id
      WHERE e.region = x.region AND e.simulated = x.simulated ${topicMatch}
        AND (x.job_workspace IS NULL OR e.workspace_id = x.job_workspace)
    ), locked AS MATERIALIZED (
      SELECT x.ordinal, e.id, e.workspace_id, e.simulated, e.status, e.provider_id ${effects ? sql`, e.to_addresses,e.cc_addresses,e.bcc_addresses` : sql``} FROM raw x
      JOIN (SELECT ordinal, min(id) AS id FROM candidates GROUP BY ordinal HAVING count(*) = 1) c USING (ordinal)
      JOIN sending_emails e ON e.id = c.id
      WHERE e.provider_id = x.provider_id OR (e.id = x.tagged_email_id AND e.provider_id IS NULL AND e.status IN ('attempting','acceptance_unknown'))
      ORDER BY e.id FOR UPDATE OF e
    ) ${mx ? sql`` : sql`, accounts AS (
      -- Same single-account binding as resolveRegionRuntime: only the installation's own registered topics count.
      SELECT s.workspace_id, CASE WHEN count(DISTINCT r.trusted_account_id) = 1 THEN min(r.trusted_account_id) END AS account
      FROM (SELECT DISTINCT workspace_id FROM locked WHERE NOT simulated) l JOIN ses_installation_settings s USING (workspace_id)
      LEFT JOIN ses_region_discovery r ON r.workspace_id = s.workspace_id AND r.trusted_account_id ~ '^[0-9]{12}$'
        AND r.trusted_topic_arn = 'arn:aws:sns:' || r.region || ':' || r.trusted_account_id || ':bane-' || left(encode(sha256(convert_to(s.installation_id, 'UTF8')), 'hex'), 20) || '-feedback'
      GROUP BY s.workspace_id
    )`}, input AS (
      SELECT x.*, coalesce(l.workspace_id, x.job_workspace) AS workspace_id, l.status, ${effects ? sql`l.to_addresses,l.cc_addresses,l.bcc_addresses,` : sql``}
        coalesce(x.recovery_type, CASE WHEN x.type = 'receipt' AND l.status = 'attempting' AND l.provider_id IS NULL THEN 'operation.ses' END) AS job_type,
        CASE WHEN x.type <> 'receipt' AND (l.provider_id IS NOT NULL OR l.status = 'acceptance_unknown') THEN l.id END AS email_id,
        CASE WHEN l.id IS NULL AND x.job_workspace IS NULL THEN 'SES_EMAIL_NOT_FOUND'
             ${mx ? sql`WHEN NOT x.simulated AND (l.id IS NULL OR to_jsonb(split_part(x.topic_arn,':',5)) IS DISTINCT FROM x.payload #> '{message,mail,sendingAccountId}') THEN 'SES_ACCOUNT_MISMATCH'` : sql`
             WHEN NOT x.simulated AND a.workspace_id IS NULL THEN 'REGION_SETTINGS_NOT_INITIALIZED'
             WHEN a.account IS NOT NULL AND to_jsonb(a.account) IS DISTINCT FROM x.payload #> '{message,mail,sendingAccountId}' THEN 'SES_ACCOUNT_MISMATCH'`} END AS error
      FROM raw x LEFT JOIN locked l USING (ordinal) ${mx ? sql`` : sql`LEFT JOIN accounts a ON a.workspace_id = l.workspace_id AND NOT x.simulated`}
    ), distinct_receipts AS (
      SELECT DISTINCT ON (topic_arn,message_id) * FROM input WHERE error IS NULL ORDER BY topic_arn,message_id,ordinal
    ), incoming AS (
      INSERT INTO operation_sns_receipts AS receipt(topic_arn, message_id, workspace_id, processed_at)
       SELECT x.topic_arn, x.message_id, x.workspace_id, CASE WHEN x.email_id IS NOT NULL THEN clock_timestamp() END
       FROM distinct_receipts x ON CONFLICT (topic_arn,message_id) DO UPDATE SET processed_at=excluded.processed_at
       WHERE receipt.processed_at IS NULL AND excluded.processed_at IS NOT NULL AND receipt.workspace_id=excluded.workspace_id
       RETURNING topic_arn, message_id, workspace_id, created_at
    ), recovery AS (
      INSERT INTO jobs(id, workspace_id, type, payload, available_at)
       SELECT DISTINCT ON (topic_arn, message_id) x.recovery_job_id, x.workspace_id, x.job_type, x.payload,
         clock_timestamp() + CASE WHEN x.type = 'receipt' AND x.status <> 'attempting' THEN interval '0 seconds' ELSE interval '15 seconds' END
       FROM distinct_receipts x JOIN incoming i USING (topic_arn, message_id, workspace_id)
      WHERE x.error IS NULL AND x.email_id IS NULL AND x.job_type IS NOT NULL RETURNING id
    ), matched AS (
      SELECT x.*, CASE WHEN x.effects->>'receiptTime'='true' THEN i.created_at ELSE x.created_at END AS event_time
      FROM distinct_receipts x JOIN incoming i USING (topic_arn,message_id,workspace_id) WHERE x.email_id IS NOT NULL
    ) ${effects ? sql`, recipients AS MATERIALIZED (
      SELECT DISTINCT x.event_id,lower(address) AS address FROM matched x,
        jsonb_array_elements_text(x.to_addresses || x.cc_addresses || x.bcc_addresses) AS address
      WHERE x.effects->'reported' ? lower(address) OR (x.effects->>'observe' IS NOT NULL AND jsonb_array_length(x.to_addresses)=1 AND x.cc_addresses='[]' AND x.bcc_addresses='[]')
    ), contact_events AS (
      -- Effects follow the receipt this statement processed, not a newly inserted event: a recovery
      -- job that stored the event and died before its suppression left the receipt open for us.
      -- The merges below are idempotent, so overlapping with that job's own retry is harmless.
      SELECT x.workspace_id,r.address,x.ordinal,x.event_time,x.effects->>'suppress' AS reason,x.effects->>'observe' AS observe,
        min(x.ordinal) FILTER (WHERE x.effects->>'suppress' IS NOT NULL) OVER (PARTITION BY x.workspace_id,r.address) AS first_suppression
      FROM matched x JOIN recipients r USING(event_id)
    ), contact_changes AS (
      -- One write per address. A missing contact starts existing at its first suppression;
      -- an earlier open must not create it or retroactively contribute engagement.
      INSERT INTO audience_contacts AS c(id,workspace_id,email,suppressed,suppression_reason,suppressed_at,last_open_at,last_click_at,open_observed_since,click_observed_since,observed_since)
      SELECT 'con_'||replace(gen_random_uuid()::text,'-',''),v.workspace_id,v.address,bool_or(reason IS NOT NULL),
        (array_agg(reason ORDER BY (reason='complaint') DESC,(reason='hard_bounce') DESC,ordinal DESC) FILTER (WHERE reason IS NOT NULL))[1],
        max(event_time) FILTER (WHERE reason IS NOT NULL),
        max(event_time) FILTER (WHERE observe='open'),max(event_time) FILTER (WHERE observe='click'),
        min(event_time) FILTER (WHERE observe='open'),min(event_time) FILTER (WHERE observe='click'),min(event_time) FILTER (WHERE observe IS NOT NULL)
      FROM contact_events v LEFT JOIN audience_contacts c ON c.workspace_id=v.workspace_id AND c.email=v.address
      WHERE (reason IS NOT NULL OR observe IS NOT NULL) AND (c.id IS NOT NULL OR ordinal>=first_suppression)
      GROUP BY v.workspace_id,v.address ORDER BY v.workspace_id,v.address ON CONFLICT ON CONSTRAINT audience_contacts_email_scope DO UPDATE SET
        ${mergeSuppression},
        last_open_at=greatest(c.last_open_at,excluded.last_open_at),last_click_at=greatest(c.last_click_at,excluded.last_click_at),
        open_observed_since=least(c.open_observed_since,excluded.open_observed_since),click_observed_since=least(c.click_observed_since,excluded.click_observed_since),
        observed_since=least(c.observed_since,excluded.observed_since),updated_at=now()
      WHERE (excluded.suppressed AND (NOT c.suppressed OR (excluded.suppression_reason = 'complaint' AND c.suppression_reason IS DISTINCT FROM 'complaint') OR (excluded.suppression_reason = 'hard_bounce' AND c.suppression_reason IS DISTINCT FROM 'complaint' AND c.suppression_reason IS DISTINCT FROM 'hard_bounce')))
        OR (excluded.suppressed AND c.suppressed AND (c.suppressed_at IS NULL OR excluded.suppressed_at > c.suppressed_at))
        OR (excluded.last_open_at IS NOT NULL AND (c.last_open_at IS NULL OR excluded.last_open_at > c.last_open_at))
        OR (excluded.last_click_at IS NOT NULL AND (c.last_click_at IS NULL OR excluded.last_click_at > c.last_click_at))
        OR (excluded.open_observed_since IS NOT NULL AND (c.open_observed_since IS NULL OR excluded.open_observed_since < c.open_observed_since))
        OR (excluded.click_observed_since IS NOT NULL AND (c.click_observed_since IS NULL OR excluded.click_observed_since < c.click_observed_since))
        OR (excluded.observed_since IS NOT NULL AND (c.observed_since IS NULL OR excluded.observed_since < c.observed_since)) RETURNING 1
    )` : sql``}, shared_locks AS MATERIALIZED (
      -- When a batch contains a suppression transition (which triggers sending_emails billing/usage/health updates
      -- after sending_email_events inserts), pre-acquire per-workspace advisory lock 275820 in ascending hashtext
      -- order across all potentially-writing workspaces in this batch so multi-workspace mixed batches never invert.
      SELECT pg_advisory_xact_lock(275820, h)
      FROM (
        SELECT DISTINCT hashtext(m.workspace_id) AS h
        FROM matched m
        WHERE EXISTS (SELECT 1 FROM matched s WHERE s.type = 'validation_suppressed' OR s.status = 'suppressed')
          AND NOT m.simulated
          AND (m.type IN ('validation_suppressed', 'complaint', 'accepted', 'send')
               OR (m.type = 'bounce' AND m.data->>'bounceType' = 'Permanent')
               OR m.status = 'suppressed')
        ORDER BY 1
      ) x ${effects ? sql`WHERE (SELECT count(*) FROM contact_changes) >= 0` : sql``}
    ), inserted AS (
      INSERT INTO sending_email_events(id, workspace_id, email_id, type, provider_id, external_id, data, simulated, created_at,recipient_hashes)
       SELECT x.event_id, x.workspace_id, x.email_id, x.type, x.provider_id, x.external_id,
         x.data || jsonb_build_object('emailId', x.email_id, 'providerId', x.provider_id), x.simulated,
         -- SES's event time, except accepted mail (not simulated): the database's clock, as the abuse sample's mark relies on.
         CASE WHEN x.type='accepted' AND NOT x.simulated THEN clock_timestamp() ELSE x.event_time END,
         ${mx && effects ? sql`CASE WHEN x.type IN ('bounce','complaint') AND jsonb_typeof(x.effects->'reported')='array'
           AND EXISTS(SELECT FROM provider_feedback_history WHERE topic_arn=x.topic_arn AND kind='shared') THEN ARRAY(
           SELECT encode(sha256(convert_to(x.email_id,'UTF8') || decode('00','hex') || convert_to(r.address,'UTF8')),'hex')
           FROM recipients r WHERE r.event_id=x.event_id AND r.address NOT LIKE '%@simulator.amazonses.com' ORDER BY r.address) END` : sql`NULL`}
       FROM matched x WHERE (SELECT count(*) FROM shared_locks) >= 0 ORDER BY x.workspace_id,x.email_id,x.ordinal
      ON CONFLICT DO NOTHING RETURNING *
    ), outcome_totals AS (
      SELECT x.email_id, x.workspace_id, bit_or(x.outcome_bit)::smallint AS add_bits
      FROM matched x JOIN inserted ins ON ins.id = x.event_id
      GROUP BY x.email_id, x.workspace_id
    ), ranked AS (
      SELECT x.*,max(x.next_rank) OVER(PARTITION BY x.email_id ORDER BY x.ordinal) AS running_rank FROM matched x JOIN inserted ins ON ins.id=x.event_id
      WHERE x.next_rank IS NOT NULL
    ), winner AS MATERIALIZED (
      SELECT DISTINCT ON (email_id) *,
        bool_or(type='validation_suppressed' AND next_rank>=greatest(running_rank,(${JSON.stringify(rank)}::jsonb->>status)::int)) OVER(PARTITION BY email_id) AS validation
      FROM ranked ORDER BY email_id,next_rank DESC,ordinal DESC
    ), email_updates AS (
      SELECT o.email_id, o.workspace_id, o.add_bits,
        (w.email_id IS NOT NULL AND w.next_rank >= (${JSON.stringify(rank)}::jsonb ->> w.status)::int) AS advance_status,
        w.next_status, w.provider_id, coalesce(w.validation, false) AS validation
      FROM outcome_totals o LEFT JOIN winner w ON w.email_id = o.email_id AND w.workspace_id = o.workspace_id
      ORDER BY o.email_id
    ), updated AS (
      -- Apply status upgrades AND outcome bits (including opens/clicks/delays where next_status IS NULL) in ONE update
      -- so sending_email_events_outcomes and operation_events_email_outcomes become 0-row no-ops on the hot path.
      UPDATE sending_emails e SET
        status = CASE WHEN u.advance_status THEN u.next_status ELSE e.status END,
        provider_id = CASE WHEN u.advance_status THEN coalesce(u.provider_id, e.provider_id) ELSE e.provider_id END,
        event_outcomes = e.event_outcomes | u.add_bits,
        error_code = CASE WHEN u.advance_status AND u.validation THEN 'EMAIL_VALIDATION_SUPPRESSED' ELSE e.error_code END,
        suppression_reason = CASE WHEN u.advance_status THEN CASE WHEN u.next_status='suppressed' AND u.validation THEN 'email_validation' END ELSE e.suppression_reason END,
        updated_at = CASE WHEN u.advance_status THEN clock_timestamp() ELSE e.updated_at END
      FROM email_updates u
      WHERE e.id = u.email_id AND e.workspace_id = u.workspace_id
        AND (u.advance_status OR (u.add_bits <> 0 AND (e.event_outcomes | u.add_bits) <> e.event_outcomes))
    ), published AS (
      INSERT INTO operation_events(id, workspace_id, type, region, created_at, data)
      SELECT ins.id, ins.workspace_id, x.public_type, x.region, ins.created_at,
         coalesce(x.public_data, x.data) || jsonb_build_object('simulated', x.simulated, 'providerId', x.provider_id, 'emailId', x.email_id)
      FROM inserted ins JOIN input x ON x.event_id = ins.id WHERE x.public_type IS NOT NULL ON CONFLICT DO NOTHING RETURNING *
    ), ${operationWebhookFanoutCtes()} SELECT x.ordinal, x.workspace_id AS "workspaceId", coalesce(x.error,CASE WHEN x.effects IS NOT NULL AND x.email_id IS NULL THEN 'SES_EMAIL_NOT_FOUND' END) AS error,
      (SELECT row_to_json(e) FROM (SELECT ins.id, ins.workspace_id AS "workspaceId", ins.email_id AS "emailId", ins.type,
        ins.provider_id AS "providerId", ins.external_id AS "externalId", ins.data, ins.simulated, ins.created_at::text AS "createdAt" FROM inserted ins WHERE ins.id = x.event_id) e) AS event,
      (SELECT count(*)::int FROM webhook_jobs) AS hooks,EXISTS(SELECT FROM recovery r WHERE r.id=x.recovery_job_id) AS recovery,
      ((SELECT count(*) FROM webhook_jobs) + (SELECT count(*) FROM recovery r WHERE r.id = x.recovery_job_id))::int AS runnable
    FROM input x ORDER BY x.ordinal`);
  return result.rows;
}
async function persistEmailEvent(runtime: Runtime, input: EmailEventInput & { emailId: string }) {
  const next = statusForEvent[input.type];
  const publicType = publicEventType[input.type];
  const outcomeBit = outcomeBitForEvent[input.type] ?? 0;
  // One transaction inside PostgreSQL instead of BEGIN/read/insert/update/enqueue/COMMIT over the
  // network. The locked row determines monotonic status; only a newly inserted event may change it
  // or publish a callback. Simulated acceptance also queues its Send/Delivery callback vehicles here
  // unless the runtime provides a feedback sink (Cloudflare pushes them to the feedback queue).
  const simulatedJobs = isSimulatedSes(runtime) && input.type === 'accepted' && !!input.providerId?.startsWith('sim_') && !runtime.feedback;
  const result = await runtime.db.execute<{ event: typeof emailEvents.$inferSelect | null; runnable: number; region: string }>(sql`WITH mail AS MATERIALIZED (
    SELECT id, status, region, simulated FROM sending_emails WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.emailId} FOR UPDATE
  ), inserted AS (
    INSERT INTO sending_email_events(id, workspace_id, email_id, type, provider_id, external_id, data, simulated, created_at, recipient_hashes)
    SELECT ${rowId('event')}, ${input.workspaceId}, mail.id, ${input.type}, ${input.providerId ?? null},
      ${input.externalId ?? null}, ${JSON.stringify(input.data ?? {})}::jsonb, mail.simulated,
      -- Accepted mail (not simulated) is stamped with the database's clock inside this statement, never another clock: the
      -- abuse sample's mark relies on it (abuse.ts sampleBound; check-premerge.ts holds every writer to it).
      CASE WHEN ${input.type}::text='accepted' AND NOT mail.simulated THEN clock_timestamp() ELSE ${input.createdAt ?? now()}::timestamptz END, ${sql.param(input.recipientHashes ?? null)}::text[]
    FROM mail ON CONFLICT DO NOTHING RETURNING *
  ), updated AS (
    UPDATE sending_emails e SET
      status = CASE WHEN ${next ?? null}::text IS NOT NULL AND ${next ? rank[next] : -1} >= (${JSON.stringify(rank)}::jsonb ->> mail.status)::int THEN ${next ?? null} ELSE e.status END,
      provider_id = CASE WHEN ${next ?? null}::text IS NOT NULL AND ${next ? rank[next] : -1} >= (${JSON.stringify(rank)}::jsonb ->> mail.status)::int THEN coalesce(${input.providerId || null}::text, e.provider_id) ELSE e.provider_id END,
      event_outcomes = e.event_outcomes | ${outcomeBit}::smallint,
      error_code = CASE WHEN ${next ?? null}::text IS NOT NULL AND ${next ? rank[next] : -1} >= (${JSON.stringify(rank)}::jsonb ->> mail.status)::int THEN coalesce(${input.errorCode ?? null}::text, e.error_code) ELSE e.error_code END,
      suppression_reason = CASE WHEN ${next ?? null}::text IS NOT NULL AND ${next ? rank[next] : -1} >= (${JSON.stringify(rank)}::jsonb ->> mail.status)::int THEN ${input.type==='validation_suppressed'?'email_validation':null} ELSE e.suppression_reason END,
      updated_at = CASE WHEN ${next ?? null}::text IS NOT NULL AND ${next ? rank[next] : -1} >= (${JSON.stringify(rank)}::jsonb ->> mail.status)::int THEN clock_timestamp() ELSE e.updated_at END
    FROM mail, inserted WHERE e.id = mail.id AND e.workspace_id = ${input.workspaceId}
      AND ((${next ?? null}::text IS NOT NULL AND ${next ? rank[next] : -1} >= (${JSON.stringify(rank)}::jsonb ->> mail.status)::int)
        OR (${outcomeBit}::smallint <> 0 AND (e.event_outcomes | ${outcomeBit}::smallint) <> e.event_outcomes))
  ), published AS (
    INSERT INTO operation_events(id, workspace_id, type, region, created_at, data)
    SELECT inserted.id, inserted.workspace_id, ${publicType ?? null}::text, mail.region, inserted.created_at,
      ${JSON.stringify({ ...(webhookData(input.data) ?? input.data ?? {}), ...(input.providerId ? { providerId: input.providerId } : {}) })}::jsonb || jsonb_build_object('emailId',mail.id,'simulated',mail.simulated)
    FROM inserted, mail WHERE ${publicType ?? null}::text IS NOT NULL ON CONFLICT DO NOTHING RETURNING *
  ), ${operationWebhookFanoutCtes()}, ${simulatedFeedbackCtes(sql`SELECT inserted.workspace_id, mail.id AS email_id, mail.region, ${input.providerId ?? null}::text AS provider_id, inserted.created_at
    FROM inserted, mail WHERE ${simulatedJobs}::boolean`, runtime.config.simulatedSes.deliveryDelayMs)}, receipt_processed AS (
    UPDATE operation_sns_receipts SET processed_at = clock_timestamp()
    WHERE workspace_id = ${input.workspaceId}
      AND topic_arn = ${input.receipt?.topicArn ?? null} AND message_id = ${input.receipt?.messageId ?? null} AND EXISTS (SELECT 1 FROM mail)
  ) SELECT (SELECT row_to_json(e) FROM (SELECT id, workspace_id AS "workspaceId", email_id AS "emailId", type,
    provider_id AS "providerId", external_id AS "externalId", data, simulated, created_at::text AS "createdAt" FROM inserted) e) AS event,
    (SELECT count(*) FROM webhook_jobs)::int AS runnable, (SELECT region FROM mail) AS region`);
  const row = result.rows[0]!;
  if (isSimulatedSes(runtime) && input.type === 'accepted' && input.providerId?.startsWith('sim_') && runtime.feedback && row.event) await queueSimulatedFeedback(runtime, [{ emailId: input.emailId, region: row.region, providerId: input.providerId, createdAt: row.event.createdAt }]);
  return row;
}
// Simulated acceptance produces the same Send/Delivery callbacks a live SNS subscription would,
// pushed through the runtime's feedback sink to exercise the live ingestion path.
export async function queueSimulatedFeedback(runtime: Runtime, accepted: { emailId: string; region: string; providerId: string; createdAt: string }[]) {
  if (!runtime.feedback || !accepted.length) return;
  const delay = runtime.config.simulatedSes.deliveryDelayMs;
  const items = accepted.flatMap(item => (['Send', 'Delivery'] as const).map(kind => {
    const at = new Date(Date.parse(item.createdAt) + (kind === 'Delivery' ? delay : 0)).toISOString();
    return { region: item.region, topicArn: `urn:bane:simulated-ses:${item.region}`, messageId: `${item.emailId}:${kind}`,
      message: { eventType: kind, mail: { messageId: item.providerId }, [kind.toLowerCase()]: { timestamp: at } } };
  }));
  await runtime.feedback.enqueue(items);
}
// Shared by campaign workers and the dispatch claim. A queued origin cannot bootstrap membership.
export function approvedOriginUser(runtime: Runtime, workspaceId: SQL, userId: SQL, direct = sql`false`) {
  const c = runtime.config;
  return sql`SELECT 1 FROM workspace_members m JOIN nightmail_users u ON u.id=m.user_id
    JOIN nightmail_oidc_identities i ON i.user_id=u.id AND i.issuer=${c.accountIssuer}
    WHERE m.workspace_id=${workspaceId} AND m.user_id=${userId}
    AND (m.role IN ('owner','admin') OR (${c.multiTenant} AND m.role='member' AND ${direct}))
    AND (${c.multiTenant} OR ${JSON.stringify(c.allowedSubjects)}::jsonb ? i.subject) LIMIT 1 FOR SHARE OF m,u,i`;
}
export async function originAllowed(runtime: Runtime, db: DbExecutor, mail: { workspaceId: string; actorKeyId: string; campaignId?: string | null; snapshot: Pick<EmailSnapshot, 'from'> }) {
  // Session-origin jobs retain the OIDC principal, not a browser session or bootstrap credential.
  // Queued work may re-check membership but must never create or restore it.
  if (mail.actorKeyId.startsWith('user_')) {
    return (await db.execute(approvedOriginUser(runtime, sql`${mail.workspaceId}`, sql`${mail.actorKeyId.slice(5)}`, sql`${!mail.campaignId}::boolean`))).rows.length > 0;
  }
  if (mail.actorKeyId.startsWith('mbk_')) {
    // Mailbox keys may send only as an address of a mailbox they are scoped to.
    const [key] = await db.select().from(mailboxKeys).where(and(eq(mailboxKeys.id, mail.actorKeyId), eq(mailboxKeys.workspaceId, mail.workspaceId),sql`mail_key_grant_allows(${mailboxKeys.workspaceId},${mailboxKeys.id},'key',${receivingPolicy(runtime.config)}::jsonb)`)).for('share');
    if (!key || key.revokedAt || !key.permissions.includes('send')) return false;
    const [owner] = await db.select({ mailboxId: mailboxAddresses.mailboxId }).from(mailboxAddresses).where(and(eq(mailboxAddresses.workspaceId, mail.workspaceId), eq(mailboxAddresses.address, mail.snapshot.from.toLowerCase())));
    return !!owner && (!key.mailboxIds || key.mailboxIds.includes(owner.mailboxId));
  }
  if (mail.actorKeyId.startsWith('mcp_')) {
    const grant = await (await wrapModuleLoad(() => import('../mcp-auth.js'))).getMcpGrantActor(runtime, mail.actorKeyId, mail.workspaceId, db, 'lasting');
    return !!grant && (!mail.campaignId || grant.role !== 'member') && grant.workspaceId === mail.workspaceId &&
      (grant.permissions.includes('manage') || grant.permissions.includes('send')) &&
      senderDomainAllowed(grant.domains, mail.snapshot.from.split('@')[1]!);
  }
  // Removed bootstrap origins fail closed; only durable API keys are accepted below.
  const [key] = await db.select().from(apiKeys).where(and(eq(apiKeys.id, mail.actorKeyId), eq(apiKeys.workspaceId, mail.workspaceId),sql`mail_key_grant_allows(${apiKeys.workspaceId},${apiKeys.id},'api_key',${receivingPolicy(runtime.config)}::jsonb)`)).for('share');
  // Shared readers allow parallel sends but conflict with revocation/permission updates through the durable attempt claim,
  // never through SES I/O. Once attempting, revocation cannot recall an in-flight provider call.
  return !!key && !key.revokedAt && (key.permissions.includes('manage') || key.permissions.includes('send')) && senderDomainAllowed(key.domains, mail.snapshot.from.split('@')[1]!);
}
export function checkedDispatchAttachments(ids: string[], rows: (typeof attachments.$inferSelect)[]) {
  validateAttachmentRows(distinctAttachmentIds(ids), rows);
  return rows;
}
