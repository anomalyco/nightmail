import { gatewayLane } from './protocol-admission.js';
/** Private protocol RPC. No OpenAPI/MCP registration. Caller cannot select a workspace,
 * inbox or bucket: the active protocol credential or API-signed object grant supplies it. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from './core/errors.js';
import { budgetedRead } from './core/http.js';
import type { App, Runtime } from './core/types.js';
import { boundRequestBody } from './request-body.js';
import { passwordDigest } from './inbox-passwords.js';
import { receivingPolicy } from './mailbox-ingest-input.js';
import { withMailObjects } from './mail-objects.js';
import { flagNames } from './inbox-folders.js';
import {objectProjection} from './protocol-preview.js';

const bad = () => new ApiError(403, 'PROTOCOL_DENIED', 'Protocol access denied.');
const name = z.string().max(255),
  token = z.string().min(1).max(120);
const login = z.object({
  op: z.literal('login'),
  user: name,
  password: z.string().min(1).max(256),
  protocol: z.enum(['imap', 'smtp']),
});
const read = z.object({
  op: z.literal('snapshot'),
  kid: token,
  path: name.nullable(),
  since: z.number().int().nonnegative().default(0),
  after: z.number().int().nonnegative().default(0),
  // A current gateway reads bodies by folder and UID (body below) and keeps no per-message handle.
  handles: z.boolean().default(true),
  // false: only what was expunged since `since` (gone), for IMAP QRESYNC; no changed messages.
  changed: z.boolean().default(true),
});
const edit = z.object({
  op: z.literal('edit'),
  kid: token,
  action: z.enum(['create', 'rename', 'delete', 'subscribe']),
  folder: name,
  path: name.nullable(),
  sub: z.boolean().nullable(),
});
const mutate = z.object({
  op: z.literal('mutate'),
  kid: token,
  action: z.enum(['copy', 'move', 'expunge', 'flags']),
  ticket: z.object({nonce:z.string().regex(/^[0-9a-f]{32}$/),issued:z.number().int().positive()}).optional(),
  folder: name,
  to: name.nullable(),
  uids: z.array(z.number().int().positive()).max(5000).nullable(),
  flags: z.array(z.string().max(64)).max(64),
  mode: z.enum(['add', 'remove', 'replace']),
  // IMAP STORE UNCHANGEDSINCE (RFC 7162), flags only: entries changed after this MODSEQ are left alone and answered
  // as modified.
  unchangedsince: z.number().int().nonnegative().optional(),
});
const body = z.union([
  z.object({ op: z.literal('body'), kid: token, handle: z.string().max(8192), headers: z.boolean().optional() }),
  z.object({ op: z.literal('body'), kid: token, folder: name, uid: z.number().int().positive(), headers: z.boolean().optional() }),
]);
const subjectSearch = z.object({
  op: z.literal('subject'),
  kid: token,
  folder: name,
  term: z.string().min(1).max(1024),
});
/** SEARCH by a header the store keeps decoded: Subject, From, To or Cc, as a substring, any case. null: a message in
 *  the folder doesn't have the field kept (a client APPEND stored before APPEND kept its addresses), so the gateway
 *  reads the headers itself. */
const fieldSearch = subjectSearch.extend({ op: z.literal('search'), field: z.enum(['subject', 'from', 'to', 'cc']) });
// An older gateway's submission: base64 inside the JSON, at most 8 MiB. A current one streams it (protocol-submit.ts).
const submit = z.object({
  op: z.literal('submit'),
  kid: token,
  from: z.email(),
  to: z.array(z.email()).min(1).max(100),
  content: z.string().max(11184812),
});
const projections = z.object({
  op: z.literal('projections'),
  kid: token,
  folder: name,
  uids: z.array(z.number().int().positive()).min(1).max(256),
});
/** The inbox's storage and message limits and use (IMAP QUOTA, RFC 9208); with a folder, also its \Deleted messages
 *  and their bytes (STATUS DELETED and DELETED-STORAGE). */
const quota = z.object({ op: z.literal('quota'), kid: token, folder: name.optional() });
const rpc = z.union([login, read, edit, mutate, body, subjectSearch, fieldSearch, submit, projections, quota]);
const mac = (key: string, value: string) => createHmac('sha256', key).update(value).digest('hex');
function equal(a: string, b: string) {
  return /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export const principal = (runtime: Runtime, protocol: 'imap' | 'smtp', identity: ReturnType<typeof sql>) =>
  sql`SELECT b.workspace_id AS w,b.id AS b,p.id AS k FROM inbox_app_passwords p JOIN mailboxes b ON b.id=p.inbox_id WHERE ${identity} AND p.revoked_at IS NULL AND ${protocol}=ANY(p.protocols) AND b.kind='inbox' AND b.retention_mode='forever' AND b.delete_after IS NULL AND NOT EXISTS(SELECT FROM mail_grant_objects g WHERE g.kind='protocol' AND g.workspace_id=b.workspace_id AND g.resource=p.id AND NOT mail_receiving_grant(b.workspace_id,g.grant_id,${receivingPolicy(runtime.config)}::jsonb))`;
const folders = sql`(SELECT jsonb_agg(jsonb_build_object('key',f.role,'path',inbox_folder_path(f),'next',f.uid_next,'validity',f.uid_validity,'highest',f.highest_modseq,'subscribed',f.subscribed,'total',f.total,'unseen',f.unseen) ORDER BY role) FROM inbox_folders f WHERE f.inbox_id=a.b)`;
/** Snapshot entries per page: a 100,000-message folder selects in ten pages. */
const PAGE = 10000;
/** An IMAP keyword is any RFC 3501 atom (printable ASCII but ( ) { % * " \ ] and space), at most 64 characters;
 *  delivery's own labels are not keywords. Migration 356 applies the same rule in SQL. */
export const KEYWORD = /^[!#$&'+-[^-z|}~]{1,64}$/;
const keyword = (label: string) => KEYWORD.test(label) && !['unverified', 'spam', 'guard-allowed'].includes(label);
const names = ['\\Flagged', '\\Answered', '\\Draft', '$Forwarded', '$Junk', '$NotJunk', '$MDNSent'] as const;
type ObjectRef = {
  w: string;
  kid: string;
  mid: string;
  key: string;
  bucket: string;
  region: string;
  header: number | null;
  size: number;
  exp: number;
};
function handle(runtime: Runtime, data: ObjectRef) {
  const d = Buffer.from(JSON.stringify(data)).toString('base64url');
  return d + '.' + mac(runtime.config.authSecret, 'mailgw-body:' + d);
}
export function registerMailGateway(app: App) {
  app.post('/internal/v1/mail', async (c) => {
    const runtime = c.env,
      hash = c.req.header('x-bane-content') ?? '';
    if (!gatewayLane(c.req.method, c.req.path, c.req.raw.headers, runtime.config.mailGatewayToken)) throw bad();
    const meta = c.req.header('x-bane-append'), submission = c.req.header('x-bane-submit');
    if (meta !== undefined) {
      const { streamedAppend } = await import('./protocol-append.js');
      return c.json(await streamedAppend(c, meta, hash));
    }
    if (submission !== undefined) {
      const { streamedSubmit } = await import('./protocol-submit.js');
      return c.json(await streamedSubmit(c, submission, hash));
    }
    await boundRequestBody(c, 23 * 1024 * 1024);
    const raw = await c.req.text();
    if (createHash('sha256').update(raw).digest('hex') !== hash) throw bad();
    const q = rpc.safeParse(JSON.parse(raw));
    if (!q.success) throw new ApiError(422, 'INVALID_REQUEST', 'Invalid protocol RPC.');
    const p = q.data;
    if (p.op === 'login') {
      // An API key signs in to SMTP only, to send (protocol-relay.ts); it is never an app password.
      if (/^(?:nm|bane|os)_/.test(p.password)) {
        const { relayLogin, relayPassword } = await import('./protocol-relay.js');
        const relay = relayPassword(p.password) ? await relayLogin(runtime, p.user, p.password, p.protocol) : null;
        if (!relay) throw bad();
        return c.json(relay);
      }
      const auth = principal(runtime, p.protocol, sql`p.hash=${passwordDigest(runtime.config.authSecret, p.password)}`);
      const { rows } = await runtime.db.execute(
        sql`WITH a AS (${auth}) SELECT a.k AS kid,a.b AS inbox,a.w AS workspace,coalesce('sponsor:'||w.quota_sponsor,'unsponsored') AS account,ARRAY(SELECT address FROM mailbox_addresses WHERE mailbox_id=a.b AND workspace_id=a.w) AS addresses,${folders} AS folders FROM a JOIN workspaces w ON w.id=a.w WHERE a.b=${p.user} OR EXISTS(SELECT FROM mailbox_addresses WHERE mailbox_id=a.b AND workspace_id=a.w AND address=lower(${p.user}))`,
      );
      if (!rows[0]) throw bad();
      return c.json(rows[0]);
    }
    if (p.op === 'body') {
      let v: ObjectRef;
      if ('uid' in p) {
        // One message by folder and UID, read under the credential now (no handle).
        const auth = principal(runtime, 'imap', sql`p.id=${p.kid}`);
        const { rows: [found] } = await runtime.db.execute<ObjectRef>(
          sql`WITH a AS (${auth}) SELECT a.w,${p.kid}::text AS kid,m.id AS mid,m.raw_key AS key,m.raw_bucket AS bucket,m.region,(m.mime->>'headerLength')::int AS header,coalesce(m.size_bytes,0) AS size,0 AS exp
            FROM a JOIN inbox_entries e ON e.inbox_id=a.b AND e.role=${p.folder} AND e.uid=${p.uid} JOIN mailbox_messages l ON l.mailbox_id=e.inbox_id AND l.message_id=e.message_id
            JOIN mail_messages m ON m.id=e.message_id AND m.workspace_id=a.w WHERE l.held_reason IS NULL AND m.raw_key IS NOT NULL AND m.raw_bucket IS NOT NULL`,
        );
        if (!found) throw new ApiError(404, 'MISSING_BODY', 'Body unavailable.');
        v = found;
      } else {
        const [d, s] = p.handle.split('.');
        if (!d || !s || !equal(s, mac(runtime.config.authSecret, 'mailgw-body:' + d))) throw bad();
        v = JSON.parse(Buffer.from(d, 'base64url').toString()) as ObjectRef;
        if (v.kid !== p.kid) throw bad();
        if (v.exp < Date.now()) {
          // Recheck only this immutable object. Do not rebuild a large folder just to renew a grant.
          const auth = principal(runtime, 'imap', sql`p.id=${p.kid}`);
          const found = await runtime.db.execute(
            sql`WITH a AS (${auth}) SELECT FROM a JOIN mailbox_messages l ON l.mailbox_id=a.b AND l.workspace_id=a.w JOIN mail_messages m ON m.id=l.message_id AND m.workspace_id=a.w WHERE l.held_reason IS NULL AND m.id=${v.mid} AND m.raw_key=${v.key} AND m.raw_bucket=${v.bucket}`,
          );
          if (!found.rowCount) throw bad();
        }
      }
      if(p.headers){
        const {bytes,end}=await objectProjection(runtime,v.w,v);
        return new Response(bytes.subarray(0,end),{headers:{'content-type':'application/octet-stream'}});
      }
      // Fair-use download allowance (297): a full body counts its size against the inbox's day and month. 509 tells the
      // gateway to answer NO [LIMIT]; headers-only fetches are free.
      const {rows:[allowed]}=await runtime.db.execute<{ok:boolean}>(sql`SELECT inbox_protocol_download(${p.kid},${v.size}) AS ok`);
      if(!allowed?.ok)throw new ApiError(509,'DOWNLOAD_LIMIT','This inbox reached its daily or monthly IMAP download allowance.',undefined,true);
      const stream = await withMailObjects(runtime, v.w, v.region, v.bucket, (o) =>
        o.get(v.key),
      );
      if (!stream) throw new ApiError(404, 'MISSING_BODY', 'Body unavailable.');
      return new Response(stream, { headers: { 'content-type': 'application/octet-stream' } });
    }
    if (p.op === 'submit') {
      const { submit } = await import('./protocol-submit.js'), raw = Buffer.from(p.content, 'base64');
      if (raw.length > 8 * 1024 * 1024) throw new ApiError(413, 'MESSAGE_SIZE', 'Message is too large.');
      return c.json(await submit(c, { kid: p.kid, from: p.from, to: p.to, raw }));
    }
    const auth = principal(runtime, 'imap', sql`p.id=${p.kid}`);
    // MATERIALIZED ensures the write fence is acquired before calling the writer.
    const writer = (ingest: boolean) => sql`SELECT a.* FROM (${auth}) a WHERE mailgw_write_allowed(a.w,a.b,a.k,${receivingPolicy(runtime.config)}::jsonb,${ingest})`;
    if (p.op === 'projections') {
      const { previewPage } = await import('./protocol-preview.js');
      const row = (
        await runtime.db.execute<{ w: string; items: Parameters<typeof previewPage>[2] }>(
          sql`WITH a AS (${auth}) SELECT a.w,ARRAY(SELECT jsonb_build_object('uid',e.uid,'mid',m.id,'key',m.raw_key,'bucket',m.raw_bucket,'region',m.region,'size',m.size_bytes,'header',m.mime->'headerLength','raw',v.prefix,'complete',v.complete) FROM inbox_entries e JOIN mailbox_messages l ON l.mailbox_id=e.inbox_id AND l.message_id=e.message_id JOIN mail_messages m ON m.id=e.message_id AND m.workspace_id=a.w LEFT JOIN mailgw_previews v ON v.mid=m.id AND v.object_key=m.raw_key WHERE l.held_reason IS NULL AND e.inbox_id=a.b AND e.role=${p.folder} AND e.uid=ANY(${sql.param(p.uids)}::bigint[])) AS items FROM a`,
        )
      ).rows[0];
      if (!row) throw bad();
      return c.json(await previewPage(runtime, row.w, row.items, writer(false)));
    }
    // IMAP search: bound to the folder's inbox_entries (held messages are never filed in inbox_entries)
    // and enforce a 5-second statement timeout returning 413 SEARCH_LIMIT (which mailgw maps to IMAP
    // NO [LIMIT], never an empty SEARCH and never a raw-header fallback over object storage).
    const searchBudget = { seconds: 5, refusal: () => new ApiError(413, 'SEARCH_LIMIT', 'Search timed out; narrow the search.') };
    if (p.op === 'search') {
      const term = sql`lower(${p.term})`, has = (text: SQL) => sql`strpos(lower(${text}),${term})>0`;
      const match = p.field === 'subject' ? has(sql`m.subject`) : p.field === 'from' ? has(sql`coalesce(m.from_name,'')||' '||m.from_address`)
        : sql`EXISTS(SELECT FROM jsonb_array_elements(m.${sql.identifier(p.field)}) x WHERE ${has(sql`coalesce(x->>'name','')||' '||coalesce(x->>'address','')`)})`;
      const unkept = p.field === 'subject' ? sql`false` : sql`EXISTS(SELECT FROM mail_messages m JOIN inbox_entries e ON e.message_id=m.id WHERE m.workspace_id=a.w AND m.verdicts->>'origin'='client-append' AND NOT (m.verdicts ? 'fields') AND e.inbox_id=a.b AND e.role=${p.folder})`;
      const row = (
        await budgetedRead(runtime.db, db => db.execute<{ uids: number[]; unkept: boolean }>(
          sql`WITH a AS MATERIALIZED (${auth}), u AS MATERIALIZED (SELECT a.*, ${unkept} AS unkept FROM a)
              SELECT u.unkept, CASE WHEN u.unkept THEN '{}'::float8[] ELSE ARRAY(
                SELECT e.uid::float8 FROM inbox_entries e
                WHERE e.inbox_id=u.b AND e.role=${p.folder}
                  AND EXISTS(SELECT 1 FROM mail_messages m WHERE m.id=e.message_id AND m.workspace_id=u.w AND ${match})
                ORDER BY e.uid LIMIT 100001
              ) END AS uids FROM u`,
        ), searchBudget)
      ).rows[0];
      if (!row) throw bad();
      if (row.uids.length > 100000) throw new ApiError(413, 'SEARCH_LIMIT', 'Narrow the search.');
      return c.json(row.unkept ? null : row.uids);
    }
    if (p.op === 'subject') {
      const row = (
        await budgetedRead(runtime.db, db => db.execute<{ uids: number[] }>(
          sql`WITH a AS MATERIALIZED (${auth})
              SELECT ARRAY(
                SELECT e.uid::float8 FROM inbox_entries e
                WHERE e.inbox_id=a.b AND e.role=${p.folder}
                  AND EXISTS(SELECT 1 FROM mail_messages m WHERE m.id=e.message_id AND m.workspace_id=a.w AND strpos(lower(m.subject),lower(${p.term}))>0)
                ORDER BY e.uid LIMIT 100001
              ) AS uids FROM a`,
        ), searchBudget)
      ).rows[0];
      if (!row) throw bad();
      if (row.uids.length > 100000) throw new ApiError(413, 'SEARCH_LIMIT', 'Narrow the search.');
      return c.json(row.uids);
    }
    if (p.op === 'quota') {
      // The limits (null: none) and use APPEND checks (protocol-append.ts).
      const deleted = p.folder === undefined ? sql`NULL::jsonb`
        : sql`(SELECT jsonb_build_object('messages',count(*)::float8,'bytes',coalesce(sum(m.size_bytes),0)::float8) FROM inbox_entries e JOIN mailbox_messages l ON l.mailbox_id=e.inbox_id AND l.message_id=e.message_id JOIN mail_messages m ON m.id=e.message_id AND m.workspace_id=a.w WHERE e.inbox_id=a.b AND e.role=${p.folder} AND e.deleted AND l.held_reason IS NULL)`;
      const row = (
        await runtime.db.execute<{ bytes: number; messages: number; quotaBytes: number | null; quotaMessages: number | null; deleted: { messages: number; bytes: number } | null }>(
          sql`WITH a AS (${auth}) SELECT s.bytes::float8 AS bytes,s.messages::float8 AS messages,b.quota_bytes::float8 AS "quotaBytes",b.quota_messages::float8 AS "quotaMessages",${deleted} AS deleted FROM a JOIN inbox_state s ON s.inbox_id=a.b JOIN mailboxes b ON b.id=a.b`,
        )
      ).rows[0];
      if (!row) throw bad();
      const { deleted: marked, ...use } = row;
      return c.json(marked ? { ...use, deleted: marked } : use);
    }
    if (p.op === 'snapshot') {
      type E = {
        uid: number;
        modseq: number;
        date: string;
        bits: number;
        seen: boolean;
        deleted: boolean;
        labels: string[];
        size: number;
        key: string | null;
        bucket: string | null;
        region: string;
        mid: string;
        header: number | null;
      };
      // Resolve the target folder role once, then page inbox_entries in UID order (stopping at PAGE + 1)
      // before joining mailbox_messages and mail_messages so a 200k-entry folder never sorts or scans all rows per page.
      const entries = p.changed
        ? sql`coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY uid) FROM (
            WITH page AS MATERIALIZED (
              SELECT e.uid,e.modseq,e.internal_date AS date,e.deleted,e.message_id
              FROM inbox_entries e
              WHERE t.role IS NOT NULL AND e.inbox_id=t.b AND e.role=t.role AND e.uid>${p.after} AND e.modseq>${p.since}
              ORDER BY e.uid LIMIT ${PAGE + 1}
            )
            SELECT p.uid,p.modseq,p.date,l.flags bits,l.read seen,p.deleted,l.labels,coalesce(m.size_bytes,0) size,m.raw_key key,m.raw_bucket bucket,m.region,m.id mid,(m.mime->>'headerLength')::int header
            FROM page p
            JOIN mailbox_messages l ON l.mailbox_id=t.b AND l.message_id=p.message_id AND l.held_reason IS NULL
            JOIN mail_messages m ON m.id=p.message_id AND m.workspace_id=t.w
            ORDER BY p.uid
          )x),'[]')`
        : sql`'[]'::jsonb`;
      const r = (
        await runtime.db.execute<{ w: string; folders: unknown; entries: E[]; gone: { uid: number }[]; floor: string }>(
          sql`WITH a AS MATERIALIZED (${auth}),
              t AS MATERIALIZED (SELECT a.w,a.b,(SELECT f.role FROM inbox_folders f WHERE f.inbox_id=a.b AND inbox_folder_path(f)=${p.path} LIMIT 1) AS role FROM a)
              SELECT t.w,${folders} folders,(SELECT changes_floor::text FROM inbox_state WHERE inbox_id=t.b) floor,
                coalesce((SELECT jsonb_agg(x ORDER BY uid) FROM (SELECT v.uid FROM inbox_vanished v WHERE ${p.since}::bigint>0 AND t.role IS NOT NULL AND v.inbox_id=t.b AND v.role=t.role AND v.modseq>${p.since} AND v.uid>${p.after} ORDER BY v.uid LIMIT ${PAGE + 1})x),'[]') AS gone,
                ${entries} AS entries FROM t a JOIN t USING(w,b)`,
        )
      ).rows[0];
      if (!r) throw bad();
      const next = Math.min(
        r.entries.length > PAGE ? r.entries[PAGE - 1]!.uid : Infinity,
        r.gone.length > PAGE ? r.gone[PAGE - 1]!.uid : Infinity,
      );
      const gone = r.gone.filter((v) => v.uid <= next).map((v) => v.uid);
      return c.json({
        folders: r.folders,
        floor: Number(r.floor),
        gone,
        more: Number.isFinite(next) ? next : null,
        entries: r.entries
          .filter((e) => e.uid <= next)
          .map((e) => ({
            uid: e.uid,
            modseq: e.modseq,
            date: e.date,
            size: e.size,
            flags: [
              ...e.labels.filter(keyword),
              ...names.filter((_, i) => e.bits & (1 << i)),
              ...(e.seen ? ['\\Seen'] : []),
              ...(e.deleted ? ['\\Deleted'] : []),
            ],
            handle:
              p.handles && e.key && e.bucket
                ? handle(runtime, {
                    w: r.w,
                    kid: p.kid,
                    mid: e.mid,
                    key: e.key,
                    bucket: e.bucket,
                    region: e.region,
                    header: e.header,
                    size: e.size,
                    exp: Date.now() + 300000,
                  })
                : null,
          })),
      });
    }
    if (p.op === 'edit') {
      const row = (
        await runtime.db.execute<{ r: { error?: string } }>(
          sql`WITH a AS MATERIALIZED (${writer(p.action === 'delete')}) SELECT inbox_edit_folder(a.w,a.b,${p.action},${p.folder},${p.path},${p.sub}) r FROM a`,
        )
      ).rows[0];
      if (!row) throw bad();
      // The refusal's own code (ALREADYEXISTS, FOLDER_LIMIT, INVALID_PATH, PROTECTED_FOLDER, NOT_FOUND) tells the
      // gateway which IMAP response code to answer.
      if (row.r.error) throw new ApiError(row.r.error === 'NOT_FOUND' ? 404 : 409, row.r.error, 'Folder mutation refused.');
      return c.json(row.r);
    }
    // A single statement takes the phase-2 inbox fence, resolves UIDs and performs the batch.
    const flags = Object.fromEntries(
      [...flagNames, 'read', 'deleted'].flatMap((k, i) => {
        const on = p.flags.some(
          (f) => f.toLowerCase() === (names[i] ?? (i === 7 ? '\\Seen' : '\\Deleted')).toLowerCase(),
        );
        return p.mode === 'replace' || on ? [[k, on && p.mode !== 'remove']] : [];
      }),
    );
    const labels = p.flags.filter(
      (x) => !x.startsWith('\\') && !names.some((n) => n.toLowerCase() === x.toLowerCase()),
    );
    if (!labels.every(keyword)) throw new ApiError(422, 'INVALID_FLAG', 'Invalid keyword.');
    if ((p.action==='flags'||p.action==='copy') && (!p.uids || p.uids.length>1000))throw new ApiError(413,'MUTATION_LIMIT','Request at most 1000 UIDs.');
    if(p.action==='copy'&&(!p.ticket||!p.to))throw new ApiError(422,'MISSING_COPY_TICKET','COPY requires a replay ticket.');
    // UNCHANGEDSINCE: keep holds the entries at or below it. FOR UPDATE reads each as it is once the inbox lock (the
    // writer fence, taken first) is held, so the check and the change are one; the rest are answered as modified.
    const conditional = p.action === 'flags' && p.unchangedsince !== undefined;
    const uids = conditional ? sql`ARRAY(SELECT uid FROM keep)::bigint[]` : sql`${sql.param(p.uids)}::bigint[]`;
    const mutation=p.action==='copy'&&p.ticket
      ?sql`mailgw_copy_once(a.w,a.b,a.k,${p.folder},${p.to},${sql.param(p.uids)}::bigint[],${p.ticket.nonce},${p.ticket.issued},${createHash('sha256').update(JSON.stringify([p.folder,p.to,p.uids])).digest('hex')})`
      :sql`mailgw_mutate(a.w,a.b,${p.folder},${p.to},${p.action},${uids},${p.mode},${JSON.stringify(flags)}::jsonb,${sql.param(labels)}::text[])`;
    const named = sql`e.inbox_id=a.b AND e.role=${p.folder} AND e.uid=ANY(${sql.param(p.uids)}::bigint[])`;
    const row = (
      await runtime.db.execute<{ r: { pairs: number[][]; validity: number; error?: string }; modified?: number[] }>(
        conditional
          ? sql`WITH a AS MATERIALIZED (${writer(false)}), keep AS MATERIALIZED (SELECT e.uid FROM a JOIN inbox_entries e ON ${named} WHERE e.modseq<=${p.unchangedsince}::bigint FOR UPDATE OF e) SELECT ${mutation} r,ARRAY(SELECT e.uid::float8 FROM inbox_entries e WHERE ${named} AND e.uid NOT IN (SELECT uid FROM keep) ORDER BY e.uid) modified FROM a`
          : sql`WITH a AS MATERIALIZED (${writer(p.action === 'expunge')}) SELECT ${mutation} r FROM a`,
      )
    ).rows[0];
    if (!row) throw bad();
    if (row.r.error) throw new ApiError(409, 'MUTATION_REFUSED', 'Mutation refused.');
    return c.json(conditional ? { ...row.r, modified: row.modified } : row.r);
  });
}
