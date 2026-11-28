import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { errors, isoTime, log, response, type ApiError, type App, type Runtime } from './core.js';
import { supportRead } from './deliverability.js';
import { narrowed, type SupportMeta } from './support-deliverability.js';

// SMTP refusals: when the API refuses a mail app's submission through the SMTP gateway (protocol-submit.ts submit), the
// gateway turns the refusal into an SMTP reply (gateway/mailgw/src/remote.rs submit_error) and the app shows it. Each is
// recorded here, after the answer (deferNudge on Workers; on Node, not awaited), so the reply never waits on the write:
// the workspace of the credential that signed in, the reply the app got (its SMTP code and text) with the API's error
// code, and the recipients' domains. Never an address, a subject or message content; a refused attachment's reply names
// the file, as the app showed it. Kept 7 days (maintenance.ts). The support agent reads them (GET
// /v1/support/smtp/refusals, owners and admins, a chat's).
//
// Not recorded: what the gateway refuses on its own inside the session without asking the API (a MAIL FROM or From
// header the credential doesn't own, too many recipients, a message past the SIZE limit), and an unsigned request.

const ATTACHMENT = new Set(['ATTACHMENT_CONTENT_MISMATCH', 'ATTACHMENT_TYPE_UNSCREENABLE', 'UNSUPPORTED_ATTACHMENT_TYPE', 'ATTACHMENT_METADATA_INVALID', 'INLINE_ATTACHMENT_INVALID', 'MIME_LIMIT']);
/** API text as the gateway puts it on one reply line (remote.rs reply_text): printable ASCII, anything else '?', at most 400 characters. */
const replyText = (message: string) => {
  const text = [...message].map(c => c === ' ' || /^[\x21-\x7e]$/.test(c) ? c : '?').join('');
  const cut = text.length > 400 ? `${text.slice(0, 397)}...` : text;
  return cut.trim() ? cut : 'Attachment refused';
};
/**
 * The gateway's SMTP reply to an API refusal, mirroring remote.rs submit_error and core/src/smtp.rs SubmitError (change
 * them together). null when it isn't a refusal: a request signed by a gateway older than this API (a deploy in progress)
 * and the API's own failures answer "451 4.3.0 Submission unavailable", and the app tries again.
 */
export function smtpReply(status: number, code: string, message: string): { code: string; text: string } | null {
  if (status === 422 && ATTACHMENT.has(code)) return { code: '550 5.6.1', text: replyText(message) };
  if (code === 'SEALED_MESSAGE_SIZE') return { code: '552 5.3.4', text: 'Signed or encrypted messages can be at most 8 MiB' };
  if (code === 'SEALED_MAIL_UNAVAILABLE') return { code: '550 5.7.1', text: 'Signed or encrypted mail is not available for this sender yet' };
  if (status === 403 && code === 'PROTOCOL_DENIED') return null;
  if (status === 413) return { code: '552 5.3.4', text: 'Message exceeds submission size limits' };
  if (status === 402) return { code: '451 4.7.1', text: 'Nightmail balance is empty; add credit in Settings > Billing' };
  if (status === 429) return { code: '451 4.7.1', text: 'Send limit reached' };
  if (status >= 400 && status < 500) return { code: '550 5.7.1', text: 'Rejected' };
  return null;
}

/** Refusals recorded per workspace an hour, at most: a client retrying into a send limit can't grow the table without
 *  bound (the read says truncated, and support sees the pattern long before). */
export const SMTP_REFUSALS_PER_HOUR = 1000;
const PER_HOUR = SMTP_REFUSALS_PER_HOUR;
/** Records the API's refusal of a gateway submission by credential `kid` to `to`, after the answer. A credential that no longer resolves to a workspace records nothing. */
export function recordSmtpRefusal(runtime: Runtime, kid: string, to: readonly string[], error: ApiError) {
  const reply = smtpReply(error.status, error.code, error.message);
  if (!reply || !/^[A-Z0-9_]{1,64}$/.test(error.code)) return;
  const domains = [...new Set(to.map(a => a.slice(a.lastIndexOf('@') + 1).toLowerCase()).filter(d => d && d.length <= 253))].sort().slice(0, 100);
  const write = async (rt: Runtime) => {
    try {
      await rt.db.execute(sql`INSERT INTO smtp_refusals(workspace_id, reply_code, reason, code, recipient_domains)
        SELECT k.w, ${reply.code}, ${reply.text}, ${error.code}, ${sql.param(domains)}::text[] FROM (
          SELECT b.workspace_id AS w FROM inbox_app_passwords p JOIN mailboxes b ON b.id = p.inbox_id WHERE p.id = ${kid}
          UNION ALL SELECT workspace_id FROM api_keys WHERE id = ${kid}
          UNION ALL SELECT workspace_id FROM mailbox_keys WHERE id = ${kid} LIMIT 1) k
        WHERE (SELECT count(*) FROM (SELECT 1 FROM smtp_refusals s WHERE s.workspace_id = k.w AND s.at > now() - interval '1 hour' LIMIT ${PER_HOUR}) n) < ${PER_HOUR}`);
    } catch {
      log('warn', { code: 'SMTP_REFUSAL_NOT_RECORDED', message: 'An SMTP refusal was answered but not recorded.' });
    }
  };
  if (runtime.deferNudge) runtime.deferNudge(write);
  else void write(runtime);
}

/** Groups of refusals returned at most; refusals of the 7 days read at most (the newest). */
const GROUPS = 50, ROWS = 5000, DOMAINS = 20;

export function registerSupportSmtp(app: App, meta: SupportMeta, WorkspaceFilter: z.ZodObject<{ workspaceId: z.ZodOptional<z.ZodString> }>) {
  const Refusal = z.object({
    workspaceId: z.string(), at: z.string().describe('The latest time.'), firstAt: z.string(), count: z.number().describe('How many times this reply was given in the 7 days.'),
    code: z.string().describe('The API’s error code, e.g. RECIPIENT_INELIGIBLE or ATTACHMENT_CONTENT_MISMATCH.'),
    smtpCode: z.string().describe('The SMTP reply code the mail app got, e.g. 550 5.7.1.'),
    reason: z.string().describe('The reply text the mail app got after its code, as it got it.'),
    recipientDomains: z.array(z.string()).describe(`The recipients’ domains (never an address), at most ${DOMAINS}.`), domainCount: z.number(),
  }).openapi('SupportSmtpRefusal');
  app.openapi(createRoute({ ...meta('listSupportSmtpRefusals', 'Submissions through the SMTP gateway that Nightmail refused in the last 7 days (a mail app or SMTP client signed in with an app password or a send-only key), grouped by reply, newest first: when, the SMTP reply the app got, the API’s error code, how many times, and the recipients’ domains. Never an address or message content.'),
    path: '/v1/support/smtp/refusals', request: { query: WorkspaceFilter }, responses: { 200: response(z.object({ data: z.array(Refusal), truncated: z.boolean() })), ...errors } }), async c => {
    const list = narrowed(c);
    if (!list.length) return c.json({ data: [], truncated: false }, 200);
    type Row = { workspace_id: string; code: string; reply_code: string; reason: string; n: number; first_at: string; last_at: string; domains: string[] | null };
    const { rows, more } = await supportRead(c.env.db, async tx => {
      const { rows } = await tx.execute<Row & { more: boolean }>(sql`WITH r AS MATERIALIZED (SELECT workspace_id, at, code, reply_code, reason, recipient_domains FROM smtp_refusals
          WHERE workspace_id = ANY(${sql.param(list)}::text[]) AND at > now() - interval '7 days' ORDER BY at DESC LIMIT ${ROWS + 1}),
        g AS (SELECT workspace_id, code, reply_code, reason, count(*)::int AS n, min(at) AS first_at, max(at) AS last_at FROM r GROUP BY 1, 2, 3, 4),
        d AS (SELECT r.workspace_id, r.code, r.reply_code, r.reason, array_agg(DISTINCT x ORDER BY x) AS domains FROM r CROSS JOIN LATERAL unnest(r.recipient_domains) x GROUP BY 1, 2, 3, 4)
        SELECT g.workspace_id, g.code, g.reply_code, g.reason, g.n, g.first_at::text, g.last_at::text, d.domains, (SELECT count(*) > ${ROWS} FROM r) AS more
        FROM g LEFT JOIN d USING (workspace_id, code, reply_code, reason) ORDER BY g.last_at DESC, g.workspace_id, g.reason LIMIT ${GROUPS + 1}`);
      return { rows, more: rows.some(r => r.more) };
    });
    const data = rows.slice(0, GROUPS).map(r => ({ workspaceId: r.workspace_id, at: isoTime(r.last_at)!, firstAt: isoTime(r.first_at)!, count: r.n, code: r.code, smtpCode: r.reply_code, reason: r.reason,
      recipientDomains: (r.domains ?? []).slice(0, DOMAINS), domainCount: r.domains?.length ?? 0 }));
    return c.json({ data, truncated: rows.length > GROUPS || more }, 200);
  });
}
