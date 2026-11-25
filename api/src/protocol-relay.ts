import { sql, type SQL } from 'drizzle-orm';
import { ApiError, digest, senderDomainAllowed, wrapModuleLoad, type Actor, type Ctx, type Runtime } from './core.js';
import { apiKeys } from './db/core.js';
import { mailboxKeys } from './db/mailbox.js';
import { API_KEY, checkBudget, credentialCtes } from './auth.js';
import { tieAllows } from './approval-ties.js';
import { submittedHeaders } from './custom-headers.js';
import { stripBlindRecipients, submissionParties } from './mailbox-mime.js';
import { envelopeParts } from './mailbox-send.js';
import { sealedPassthrough, submittedFile, type Submitted } from './protocol-submit.js';
import { SEND_LIMITS } from './send-limits.js';
import { parseSubmission, sealedMime } from './submission-mime.js';

/**
 * Send-only SMTP for apps. An app signs in to the mail gateway's SMTP with the username `apikey` and, as the password,
 * an API key that can only send: a workspace key with send alone, limited to sender domains, or a key for receiving
 * addresses with send alone. Its messages go through POST /v1/emails/send (sending.ts admitRelayed): the same
 * admission, limits, screening, billing, suppression, events and dispatch checks as a request with that key, and the
 * key's own minute budget. It never opens a mailbox: IMAP refuses it and it has no folders.
 *
 * The gateway keys the session by the key's ID where an app password's uses its inbox (session limits, cached logins,
 * revocation: migration 346 notifies bane_protocol_auth with the key's ID).
 */
const RELAY_USER = 'apikey';
const ADDRESS_KEY = /^(?:nm|bane|os)_mbx_[0-9a-f]{64}$/; // bane_/os_: remove after rename cleanup
/** Whether a password is an API key rather than an app password (four-character groups of hex). */
export const relayPassword = (password: string) => API_KEY.test(password) || ADDRESS_KEY.test(password);
/** The key behind a gateway credential ID, or null for an app password. */
const relayKind = (kid: string) => kid.startsWith('key_') ? 'api_key' as const : kid.startsWith('mbk_') ? 'key' as const : null;
type Kind = NonNullable<ReturnType<typeof relayKind>>;

/** A key that can only send, as a row `k` with the columns credentialCtes reads. `match` picks it by hash or ID. */
function sendOnlyKey(runtime: Runtime, kind: Kind, match: SQL) {
  const cfg = runtime.config, budget = sql`${cfg.apiRateLimitPerMinute}::int AS max_requests`;
  return kind === 'api_key'
    ? sql`SELECT k.id,k.workspace_id,k.id AS key_id,k.permissions,k.domains,k.expires_at,${budget} FROM api_keys k WHERE ${match} AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at>now()) AND k.permissions ? 'send' AND NOT k.permissions ?| ARRAY['read','manage'] AND k.domains<>'[]'::jsonb AND ${tieAllows(cfg, sql`k.workspace_id`, sql`k.id`, 'api_key')}`
    : sql`SELECT k.id,k.workspace_id,k.id AS key_id,k.permissions,'[]'::jsonb AS domains,k.mailbox_ids,k.expires_at,${budget} FROM mailbox_keys k WHERE ${match} AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at>now()) AND k.inbox_id IS NULL
        AND k.permissions ? 'send' AND NOT k.permissions ?| ARRAY['read','modify','create'] AND ${tieAllows(cfg, sql`k.workspace_id`, sql`k.id`, 'key')}`;
}
/** The addresses a key for receiving addresses sends from (its addresses and their aliases; never an agent inbox's),
 *  for the key row `k`. */
const sendable = sql`SELECT lower(b.address) FROM mailbox_addresses b JOIN mailboxes m ON m.workspace_id=b.workspace_id AND m.id=b.mailbox_id
  WHERE b.workspace_id=k.workspace_id AND (k.mailbox_ids IS NULL OR k.mailbox_ids ? b.mailbox_id) AND m.kind='address' AND (m.expires_at IS NULL OR m.expires_at>now())`;
const owns = (kind: Kind, addresses: string[]) => kind === 'key' ? sql`NOT EXISTS (SELECT FROM unnest(${sql.param(addresses)}::text[]) r WHERE r NOT IN (${sendable}))` : sql`true`;

/** The gateway's principal for an SMTP sign-in with a send-only key, or null. Its senders: the key's domains, or its
 *  addresses; past 1,000 addresses the gateway leaves the check to submission (anySender). expiresInMs: how long the key
 *  has left, if it expires; the gateway reuses the login and keeps the session open no longer than that. */
export async function relayLogin(runtime: Runtime, user: string, password: string, protocol: 'imap' | 'smtp') {
  if (protocol !== 'smtp' || user.toLowerCase() !== RELAY_USER) return null;
  const kind: Kind = ADDRESS_KEY.test(password) ? 'key' : 'api_key';
  const addresses = kind === 'key' ? sql`(SELECT DISTINCT a FROM (${sendable} LIMIT 1001) x(a))` : sql`(SELECT NULL::text a WHERE false)`;
  const { rows: [row] } = await runtime.db.execute(sql`WITH k AS MATERIALIZED (${sendOnlyKey(runtime, kind, sql`k.hash=${await digest(password)}`)})
    SELECT k.id AS kid,k.id AS inbox,k.workspace_id AS workspace,coalesce('sponsor:'||w.quota_sponsor,'unsponsored') AS account,
      CASE WHEN s.n<=1000 THEN s.list ELSE '[]'::jsonb END AS addresses,k.domains,s.n>1000 AS "anySender",'[]'::jsonb AS folders,
      floor(extract(epoch FROM k.expires_at-clock_timestamp())*1000)::float8 AS "expiresInMs"
    FROM k LEFT JOIN workspaces w ON w.id=k.workspace_id
    CROSS JOIN LATERAL (SELECT count(*)::int n,coalesce(jsonb_agg(a ORDER BY a),'[]') list FROM ${addresses} s) s`);
  return row ?? null;
}

/**
 * An SMTP submission with a send-only key, sent as POST /v1/emails/send with that key. In order, so nothing is written
 * for a submission that can't go out: the key is read and charged as one request against its minute budget (refused
 * at once when spent or revoked); the senders are checked; the message is built and its sender's admission checked
 * as sendEmail would, without sending; only then are its attachments uploaded, as the key; and the send is admitted
 * in sendEmail's one statement, which reads the key again (revoked or narrowed meanwhile: refused) but charges nothing
 * more. An envelope past 50 recipients is admitted as one batch of emails of up to 50 each, To and Cc first.
 */
export async function relaySubmit(c: Ctx, p: Submitted) {
  const rt = c.env, kind = relayKind(p.kid)!, table = kind === 'api_key' ? apiKeys : mailboxKeys, raw = stripBlindRecipients(p.raw, true);
  const parsed = await parseSubmission(raw);
  if (!parsed) throw new ApiError(422, 'MIME_LIMIT', 'Message could not be safely parsed.');
  const m = parsed.mail;
  // One From, at most one Sender, and both with the envelope sender inside what the key sends from.
  const { from: sender, senders, to, cc, bcc } = submissionParties(m, p), addresses = senders ?? [];
  const { rows: [key] } = await rt.db.execute<{ workspace_id: string; domains: string[]; owned: boolean; used: number; max_requests: number }>(sql`WITH
    ${credentialCtes(table, sendOnlyKey(rt, kind, sql`k.id=${p.kid}`))} SELECT k.workspace_id,k.domains,${owns(kind, addresses)} AS owned,budget.used,k.max_requests FROM credential k,budget`);
  if (!key) throw new ApiError(403, 'CREDENTIAL_REVOKED', 'Protocol access denied.');
  checkBudget(c, key.used, key.max_requests);
  if (!sender || !senders || !key.owned || senders.some(a => !senderDomainAllowed(key.domains, a.split('@')[1]!)))
    throw new ApiError(403, 'SENDER_NOT_OWNED', 'Send from an address this key may use.');
  const mime = sealedMime(raw) ? await sealedPassthrough(rt, key.workspace_id, raw, sender, m.sender?.address) : undefined, files = mime ? [] : parsed.files;
  if (files.length > SEND_LIMITS.attachments) throw new ApiError(422, 'VALIDATION_FAILED', `At most ${SEND_LIMITS.attachments} attachments.`, 'attachments');
  const messages = (attachments: string[]) => envelopeParts({ to, cc, bcc }).map(part => ({
    from: sender, ...m.from?.name ? { fromName: m.from.name } : {}, ...part, replyTo: (m.replyTo ?? []).flatMap(a => a.address ? [a.address] : []),
    subject: m.subject || '(no subject)', ...m.text?.trim() ? { text: m.text } : m.html ? {} : { text: ' ' }, ...m.html ? { html: m.html } : {},
    attachments, headers: submittedHeaders(m.headers.map(h => ({ name: h.originalKey, value: h.value }))), ...mime ? { mime } : {},
  }));
  const { storeAttachmentBytes, admitRelayed, checkRelayed } = await wrapModuleLoad(() => import('./sending.js'));
  const a: Actor = { keyId: p.kid, workspaceId: key.workspace_id, permissions: ['send'], domains: key.domains };
  if (files.length) await checkRelayed(rt, a, messages([])[0]!);
  // One file decoded at a time, each let go once it is stored.
  const attachments: string[] = [];
  for (const f of files.map(submittedFile)) attachments.push((await storeAttachmentBytes(rt, { workspaceId: key.workspace_id }, f, f.bytes(), p.kid)).id);
  // The key as the statement reads it now; its budget was charged above, so the statement charges nothing.
  const credential = sql`credential AS MATERIALIZED (${sendOnlyKey(rt, kind, sql`k.id=${p.kid}`)} AND ${owns(kind, addresses)}), budget AS (SELECT 0 AS used)`;
  const [first] = await admitRelayed(rt, messages(attachments), credential, k => {
    const actor: Actor = { keyId: k.id, workspaceId: k.workspace_id, permissions: ['send'], domains: k.domains };
    c.set('actor', actor);
    return actor;
  });
  return first!;
}
