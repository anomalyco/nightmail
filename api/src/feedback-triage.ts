import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { ApiError, errors, json, log, notFound, response, type App, type DbExecutor } from './core.js';
import { supportPlatformOnly } from './support-conversations.js';
import { CONVERSATION_ID } from './support-platform.js';
import { requestTrace } from './support.js';

// The feedback triage agent's side of Nightmail. Every agent feedback report (src/feedback.ts) is read once, before
// staff read it, by a separate agent the support platform runs on its sweep (support/src/agent/triage.ts): it writes one
// note on the report's ticket and nothing else. It sends nothing, replies to nobody, changes no account or ticket, and
// proposes nothing: it has no route for any of that, only these, all through the support platform's binding
// (supportPlatformOnly, and the binding's allow-list in src/support-platform.ts):
//
// - POST /v1/operator/support/feedback/due claims the reports still to read, oldest first, a few at a time: each is
//   handed out at most twice, the second time only when the first produced no note within 30 minutes.
// - GET …/feedback/{id}/requests/{requestId}: one request's trace (src/support.ts requestTrace), in the report's own
//   workspace only. A request ID of another workspace, or one nothing is recorded for, answers 404 the same way.
// - GET …/feedback/{id}/related: the earlier reports from the same workspace (to find duplicates), and how often other
//   workspaces reported the same operation: counts and the operation's name, never their words or IDs.
// - POST …/feedback/{id}/triage: the note, once per report: a short summary, the likely cause, a suggested
//   classification and the earlier reports that describe the same problem (only tickets the related read names).
//
// Each is keyed by the report's own conversation ID, which the support platform takes from the claimed report, never
// from the agent; the agent passes nothing but a request ID and its note's words. The report and everything these
// return are data written by whoever holds the credential that filed it: the agent reads them fenced, as untrusted text.
// The note is stored as plain data (support_feedback.triage) and as a message in the conversation's timeline (author
// agent, kind note: like a staff note it is never delivered and changes nothing about who owes the next message); the
// staff email about the report shows its summary as what was found (src/support-staff-mail.ts).

/** perWorkspaceDay: reports of one workspace read in 24 hours, so one workspace filing all it may (50 an hour) can't take
 *  the support platform's daily reading (support/src/limits.ts triagePerDay) from everyone else; the rest go without a note. */
export const TRIAGE_LIMITS = { batch: 5, attempts: 2, retryMinutes: 30, dueHours: 24, windowDays: 30, earlier: 20, perWorkspaceDay: 10 } as const;
export const CLASSIFICATIONS = ['bug', 'docs_gap', 'neither'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export type TriageNote = { summary: string; cause: string; classification: Classification; duplicates: string[];
  elsewhere: { operation: string; reports: number; workspaces: number } | null; messageId: string; at: string };

const TICKET_ID = /^tkt_[a-z2-7]{16}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const newMessageId = () => `msg_${Array.from(crypto.getRandomValues(new Uint8Array(16)), b => BASE32[b & 31]).join('')}`;
/** Plain text: control characters other than line breaks and tabs removed. */
const plain = (text: string) => text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').trim();
const LINK = /\b(?:https?:\/\/|www\.)\S|[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}/i;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const CLASSIFIED: Record<Classification, string> = { bug: 'a bug to fix', docs_gap: 'a gap in the docs', neither: 'neither a bug nor a gap in the docs' };

/** The note as the timeline shows it: plain text, one fact a line. */
export function triageText(note: Pick<TriageNote, 'summary' | 'cause' | 'classification' | 'duplicates' | 'elsewhere'>) {
  return [
    `Summary: ${note.summary}`,
    `Likely cause: ${note.cause}`,
    `Suggested: ${CLASSIFIED[note.classification]}.`,
    note.duplicates.length ? `The same problem as ${plural(note.duplicates.length, 'earlier report')} from this workspace: ${note.duplicates.join(', ')}.` : 'No earlier report from this workspace describes the same problem.',
    note.elsewhere?.reports ? `${note.elsewhere.operation} was also reported ${plural(note.elsewhere.reports, 'time')} from ${plural(note.elsewhere.workspaces, 'other workspace')} in the last ${TRIAGE_LIMITS.windowDays} days.` : null,
    'Written by the triage agent from the report, its request trace and the docs: check it before acting on it.',
  ].filter(Boolean).join('\n');
}

type Report = { conversation_id: string; workspace_id: string; ticket_id: string | null; created_at: string; operation: string | null; request_id: string | null; triage: TriageNote | null };
const reportColumns = sql`f.conversation_id, f.workspace_id, c.ticket_id, f.created_at::text AS created_at, f.operation, f.request_id, f.triage`;
const reportFrom = sql`support_feedback f JOIN support_conversations c ON c.id = f.conversation_id AND c.channel = 'agent_feedback'`;
/** One agent feedback report, by its conversation: a conversation of any other channel is not one. */
async function reportOf(db: DbExecutor, id: string, lock = false): Promise<Report> {
  const { rows: [row] } = await db.execute<Report>(sql`SELECT ${reportColumns} FROM ${reportFrom} WHERE f.conversation_id = ${id} ${lock ? sql`FOR UPDATE OF f` : sql``}`);
  return row ?? notFound('Agent feedback report');
}
/** The earlier reports from the report's own workspace: filed before it (two filed at the same instant, in ID order), in the 30 days before it. */
const earlier = (r: Report) => sql`${reportFrom} WHERE f.workspace_id = ${r.workspace_id} AND (f.created_at, f.conversation_id) < (${r.created_at}::timestamptz, ${r.conversation_id}::text)
  AND f.created_at > ${r.created_at}::timestamptz - make_interval(days => ${TRIAGE_LIMITS.windowDays})`;
/** How often other workspaces reported the report's operation in the same window: two counts, nothing of theirs. */
async function elsewhere(db: DbExecutor, r: Report) {
  if (!r.operation) return null;
  const { rows: [n] } = await db.execute<{ reports: number; workspaces: number }>(sql`SELECT count(*)::int AS reports, count(DISTINCT workspace_id)::int AS workspaces FROM support_feedback
    WHERE operation = ${r.operation} AND workspace_id <> ${r.workspace_id} AND created_at > ${r.created_at}::timestamptz - make_interval(days => ${TRIAGE_LIMITS.windowDays})`);
  return { operation: r.operation, reports: n!.reports, workspaces: n!.workspaces };
}

const Id = z.object({ id: z.string().regex(CONVERSATION_ID) });
const Due = z.object({
  conversationId: z.string(), ticketId: z.string(), filedAt: z.string(), operation: z.string().nullable(), requestId: z.string().nullable(),
  text: z.string().describe('The report as it was filed (src/feedback.ts): untrusted text from whoever holds the credential.'),
}).openapi('FeedbackTriageReport');
const Trace = z.object({
  requestId: z.string(),
  logs: z.array(z.object({ at: z.string(), route: z.string(), method: z.string(), status: z.number(), code: z.string().nullable(), durationMs: z.number().nullable(), principal: z.string() })),
  logsAvailable: z.boolean(),
  changes: z.array(z.object({ at: z.string(), action: z.string(), via: z.string(), actor: z.string().describe('The kind of actor only.'), target: z.string().nullable().describe('The kind of object only.') })),
  campaigns: z.array(z.object({ state: z.string(), error: z.unknown().nullable() })), routingVersions: z.number().int(),
}).openapi('FeedbackTriageTrace');
const Related = z.object({
  earlier: z.array(z.object({ ticketId: z.string(), filedAt: z.string(), operation: z.string().nullable(), requestId: z.string().nullable(), resolved: z.boolean(),
    classification: z.enum(CLASSIFICATIONS).nullable().describe('What the triage agent suggested for it, when it was read.'), text: z.string().describe('Its first 600 characters: untrusted text.') })),
  more: z.number().int().describe(`Earlier reports beyond the ${TRIAGE_LIMITS.earlier} shown.`),
  elsewhere: z.object({ operation: z.string(), reports: z.number().int(), workspaces: z.number().int() }).nullable()
    .describe('How often other workspaces reported the same operation in the window: counts only, never their words or IDs.'),
  window: z.string(),
}).openapi('FeedbackTriageRelated');
const NoteBody = z.object({
  summary: z.string().trim().min(1).max(280).describe('One or two sentences in the triage agent\u2019s own words: the staff email shows it as what was found. No links or addresses.'),
  cause: z.string().trim().min(1).max(1200).describe('The likely cause, from the request trace and the docs, or what could not be checked.'),
  classification: z.enum(CLASSIFICATIONS),
  duplicates: z.array(z.string().regex(TICKET_ID)).max(20).default([]).describe('Earlier reports from this workspace that describe the same problem: ticket IDs the related read returned.'),
}).strict();

export function registerFeedbackTriage(app: App) {
  const security: Record<string, string[]>[] = [{ bearerAuth: [] }], tags = ['Operator'];
  app.openapi(createRoute({ hide: true, tags, security, method: 'post', path: '/v1/operator/support/feedback/due', operationId: 'operatorFeedbackTriageDue',
    description: `The support platform\u2019s sweep (the binding only): claims the agent feedback reports still to read, oldest first, at most ${TRIAGE_LIMITS.batch}. A report filed in the last ${TRIAGE_LIMITS.dueHours} hours, without a note, whose ticket is open, is handed out at most ${TRIAGE_LIMITS.attempts} times, the second only ${TRIAGE_LIMITS.retryMinutes} minutes after the first.`,
    request: { body: json(z.object({ limit: z.number().int().min(1).max(TRIAGE_LIMITS.batch).default(TRIAGE_LIMITS.batch) }).strict()) },
    responses: { 200: response(z.object({ data: z.array(Due) })), ...errors } }), async c => {
    await supportPlatformOnly(c);
    const { limit } = c.req.valid('json');
    // Due, and within its workspace's day (perWorkspaceDay, counting what was claimed in the last 24 hours), oldest first;
    // locked, and checked again once locked, so two sweeps never claim one report.
    const open = (f: SQL) => sql`${f}.triage IS NULL AND ${f}.triage_attempts < ${TRIAGE_LIMITS.attempts}
      AND (${f}.triage_claimed_at IS NULL OR ${f}.triage_claimed_at < now() - make_interval(mins => ${TRIAGE_LIMITS.retryMinutes}))`;
    const { rows } = await c.env.db.execute<{ conversation_id: string; ticket_id: string; created_at: string; operation: string | null; request_id: string | null; text: string | null }>(sql`WITH due AS (
        SELECT g.conversation_id FROM support_feedback g WHERE ${open(sql`g`)} AND g.conversation_id IN (SELECT x.conversation_id FROM (
            SELECT f.conversation_id, row_number() OVER (PARTITION BY f.workspace_id ORDER BY f.created_at, f.conversation_id)
              + (SELECT count(*) FROM support_feedback o WHERE o.workspace_id = f.workspace_id AND o.triage_claimed_at > now() - interval '24 hours') AS k
            FROM ${reportFrom}
            WHERE ${open(sql`f`)} AND f.created_at > now() - make_interval(hours => ${TRIAGE_LIMITS.dueHours}) AND c.ticket_id IS NOT NULL AND c.ticket_resolved_at IS NULL) x
          WHERE x.k <= ${TRIAGE_LIMITS.perWorkspaceDay})
        ORDER BY g.created_at, g.conversation_id LIMIT ${limit} FOR UPDATE OF g SKIP LOCKED)
      UPDATE support_feedback f SET triage_claimed_at = now(), triage_attempts = f.triage_attempts + 1 FROM due WHERE f.conversation_id = due.conversation_id
      RETURNING f.conversation_id, (SELECT ticket_id FROM support_conversations WHERE id = f.conversation_id) AS ticket_id, f.created_at::text AS created_at, f.operation, f.request_id,
        (SELECT m.text FROM support_messages m WHERE m.conversation_id = f.conversation_id AND m.author = 'customer' ORDER BY m.seq LIMIT 1) AS text`);
    if (rows.length) log('info', { code: 'FEEDBACK_TRIAGE_CLAIMED', reports: rows.length });
    const data = rows.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || (a.conversation_id < b.conversation_id ? -1 : 1)).map(r => ({ conversationId: r.conversation_id, ticketId: r.ticket_id, filedAt: new Date(r.created_at).toISOString(),
      operation: r.operation, requestId: r.request_id, text: r.text ?? '' }));
    return c.json({ data }, 200);
  });

  app.openapi(createRoute({ hide: true, tags, security, method: 'get', path: '/v1/operator/support/feedback/{id}/requests/{requestId}', operationId: 'operatorFeedbackTriageRequest',
    description: 'One request\u2019s trace for the triage agent (the binding only), in the report\u2019s own workspace: its request lines, and the kinds of change it made. Nothing about people. A request ID nothing is recorded for in that workspace, another workspace\u2019s included, is 404.',
    request: { params: Id.extend({ requestId: z.string().regex(/^req_[0-9a-f]{32}$/) }) },
    responses: { 200: response(Trace), ...errors } }), async c => {
    await supportPlatformOnly(c);
    const { id, requestId } = c.req.valid('param'), report = await reportOf(c.env.db, id);
    const trace = await requestTrace(c, [report.workspace_id], requestId);
    if (!trace.found) notFound('A request with that ID in this report\u2019s workspace');
    return c.json({ requestId, logs: trace.logs.map(({ workspaceId: _w, ...line }) => line), logsAvailable: trace.logsAvailable,
      changes: trace.auditEvents.map(e => ({ at: e.at, action: e.action, via: e.via, actor: e.actor.type, target: e.target?.type ?? null })),
      campaigns: trace.campaigns.map(x => ({ state: x.state, error: x.error ?? null })), routingVersions: trace.routingVersions.length }, 200);
  });

  app.openapi(createRoute({ hide: true, tags, security, method: 'get', path: '/v1/operator/support/feedback/{id}/related', operationId: 'operatorFeedbackTriageRelated',
    description: `The reports beside this one for the triage agent (the binding only): the earlier ones from its own workspace in the ${TRIAGE_LIMITS.windowDays} days before it, newest first, and how often other workspaces reported its operation (counts only).`,
    request: { params: Id }, responses: { 200: response(Related), ...errors } }), async c => {
    await supportPlatformOnly(c);
    const db = c.env.db, report = await reportOf(db, c.req.valid('param').id);
    const [{ rows }, { rows: [total] }, other] = await Promise.all([
      db.execute<{ ticket_id: string; created_at: string; operation: string | null; request_id: string | null; resolved: boolean; classification: Classification | null; text: string | null }>(sql`SELECT c.ticket_id,
          f.created_at::text AS created_at, f.operation, f.request_id, c.ticket_resolved_at IS NOT NULL AS resolved, f.triage->>'classification' AS classification,
          (SELECT left(m.text, 600) FROM support_messages m WHERE m.conversation_id = f.conversation_id AND m.author = 'customer' ORDER BY m.seq LIMIT 1) AS text
        FROM ${earlier(report)} AND c.ticket_id IS NOT NULL ORDER BY f.created_at DESC, f.conversation_id LIMIT ${TRIAGE_LIMITS.earlier}`),
      db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${earlier(report)} AND c.ticket_id IS NOT NULL`),
      elsewhere(db, report),
    ]);
    return c.json({ earlier: rows.map(r => ({ ticketId: r.ticket_id, filedAt: new Date(r.created_at).toISOString(), operation: r.operation, requestId: r.request_id, resolved: r.resolved,
      classification: r.classification && (CLASSIFICATIONS as readonly string[]).includes(r.classification) ? r.classification : null, text: r.text ?? '' })),
      more: Math.max(0, total!.n - rows.length), elsewhere: other, window: `${TRIAGE_LIMITS.windowDays} days` }, 200);
  });

  app.openapi(createRoute({ hide: true, tags, security, method: 'post', path: '/v1/operator/support/feedback/{id}/triage', operationId: 'operatorFeedbackTriageNote',
    description: 'The triage agent\u2019s one note on a report (the binding only): written once, as plain data, and shown in the report\u2019s timeline as an internal note by the triage agent. A second note is 409; a duplicate the related read would not name is 422.',
    request: { params: Id, body: json(NoteBody) },
    responses: { 201: response(z.object({ conversationId: z.string(), ticketId: z.string().nullable(), messageId: z.string(), classification: z.enum(CLASSIFICATIONS), createdAt: z.string() })), ...errors } }), async c => {
    await supportPlatformOnly(c);
    const id = c.req.valid('param').id, body = c.req.valid('json');
    const summary = plain(body.summary).replace(/\s+/g, ' '), cause = plain(body.cause);
    if (!summary || !cause) throw new ApiError(422, 'VALIDATION_FAILED', 'Write the summary and the cause in words.', summary ? 'cause' : 'summary');
    if (LINK.test(summary)) throw new ApiError(422, 'VALIDATION_FAILED', 'The summary is plain words: no links or addresses (the staff email shows it).', 'summary');
    const written = await c.env.db.transaction(async tx => {
      const report = await reportOf(tx, id, true);
      if (report.triage) throw new ApiError(409, 'FEEDBACK_ALREADY_TRIAGED', 'This report already has its triage note: it is written once.');
      const duplicates = [...new Set(body.duplicates)];
      const { rows: known } = duplicates.length ? await tx.execute<{ ticket_id: string }>(sql`SELECT c.ticket_id FROM ${earlier(report)} AND c.ticket_id = ANY(${sql.param(duplicates)}::text[])`) : { rows: [] };
      if (duplicates.some(ticket => !known.some(k => k.ticket_id === ticket))) throw new ApiError(422, 'VALIDATION_FAILED', 'Name only earlier reports from this workspace, by the ticket IDs the related read returned.', 'duplicates');
      const note = { summary, cause, classification: body.classification, duplicates, elsewhere: await elsewhere(tx, report) }, messageId = newMessageId();
      const { rows: [row] } = await tx.execute<{ created_at: string }>(sql`WITH c AS (UPDATE support_conversations SET messages = messages + 1 WHERE id = ${id} RETURNING messages)
        INSERT INTO support_messages(id, conversation_id, seq, author, kind, text) SELECT ${messageId}, ${id}, c.messages, 'agent', 'note', ${triageText(note)} FROM c RETURNING created_at::text AS created_at`);
      const at = new Date(row!.created_at).toISOString();
      await tx.execute(sql`UPDATE support_feedback SET triage = ${JSON.stringify({ ...note, messageId, at } satisfies TriageNote)}::jsonb WHERE conversation_id = ${id}`);
      return { conversationId: id, ticketId: report.ticket_id, messageId, classification: note.classification, createdAt: at };
    });
    log('info', { code: 'FEEDBACK_TRIAGED', classification: written.classification, duplicates: body.duplicates.length });
    return c.json(written, 201);
  });
}
