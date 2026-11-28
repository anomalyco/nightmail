import { type z, createRoute } from '@hono/zod-openapi';
import { sql, and, gt, asc, eq } from 'drizzle-orm';
import type { Ctx, App } from '../core/types.js';
import { actor } from '../core/access.js';
import { ApiError, errors, notFound } from '../core/errors.js';
import { security, json, response, chargeBudget, id, PageQuery, page, IdParams, statementTimedOut } from '../core/http.js';
import { imports, lists } from '../db/audience.js';
import { noteEnqueued } from '../jobs.js';
import { MEMORY_LIMITS, type MemoryLease, reserveMemory, runInMemoryScope } from '../isolate-memory.js';
import { streamTextPartsResponse } from '../read-bounds.js';
import { type HygieneLists, noRisks, validAddress, classifyAddress, domainOf, hygieneLists, domainRisks, bouncedElsewhere } from '../list-hygiene.js';
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, ImportInput, ContactInput, type ImportMeta, receiptRisk, IMPORT_OPEN_PREVIEW_CAP, IMPORT_PREVIEW_RATE_PER_MINUTE, Import, findList, importPreviewReservationBytes, IMPORT_DNS_MS, scopeValues, importMetaColumns, scope, paginate, importSummary, IMPORT_GET_RESERVATION_BYTES, importNotFound, ImportCommit, CommittedImport, IMPORT_COMMIT_RESERVATION_BYTES, CONTACT_PROPERTIES_MAX_KEYS, CONTACT_PROPERTIES_DB_MAX_BYTES, IMPORT_SAMPLE_CONTACT_IDS, isContactSizeCheckViolation } from './schemas.js';
import { riskyFrom } from './counts.js';

function utf8ByteLength(text: string): number {
  let bytes = text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) continue;
    if (code < 0x800) bytes += 1;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      bytes += 2;
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    } else bytes += 2;
  }
  return bytes;
}
// Streams one CSV row at a time into a reused buffer using charCodeAt scanning (no RegExp match allocations
// and no 50,000-element string[][] in Worker memory). Rules match app/src/features/audience/csv.ts.
function forEachCsvRow(text: string, onRow: (values: string[], rowIndex: number) => void): number {
  if (utf8ByteLength(text) > IMPORT_MAX_BYTES) throw new ApiError(413, 'IMPORT_TOO_LARGE', 'CSV imports are limited to 5 MiB and 50,000 contact rows.');
  const len = text.length, row: string[] = [];
  let i = len > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0, cell = '', hasCell = false, endedQuote = false, yielded = 0;
  const flushRow = () => {
    row.push(cell); cell = ''; hasCell = false; endedQuote = false;
    let nonBlank = false;
    for (let k = 0; k < row.length; k++) if (row[k]!.trim()) { nonBlank = true; break; }
    if (nonBlank) {
      yielded++;
      if (yielded > IMPORT_MAX_ROWS + 1) throw new ApiError(413, 'IMPORT_TOO_LARGE', 'CSV imports are limited to 50,000 contact rows.');
      onRow(row, yielded);
    }
    row.length = 0;
  };
  while (i < len) {
    const start = i;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 44 || c === 34 || c === 10 || c === 13) break;
      i++;
    }
    if (i > start) {
      if (endedQuote) {
        for (let k = start; k < i; k++) { const c = text.charCodeAt(k); if (c !== 32 && c !== 9) throw new ApiError(422, 'INVALID_CSV', 'Unexpected text after a quoted field.'); }
      } else {
        cell = hasCell ? cell + text.slice(start, i) : text.slice(start, i);
        hasCell = true;
      }
    }
    if (i >= len) break;
    const c = text.charCodeAt(i);
    if (c === 34) {
      if (hasCell || endedQuote) throw new ApiError(422, 'INVALID_CSV', 'Unexpected quote: quote the whole field and double embedded quotes.');
      let from = i + 1;
      for (;;) {
        const quote = text.indexOf('"', from);
        if (quote < 0) throw new ApiError(422, 'INVALID_CSV', 'A quoted field has no closing quote.');
        cell = hasCell ? cell + text.slice(from, quote) : text.slice(from, quote);
        hasCell = true;
        if (text.charCodeAt(quote + 1) !== 34) { from = quote + 1; break; }
        cell += '"'; from = quote + 2;
      }
      endedQuote = true; i = from;
    } else if (c === 44) {
      row.push(cell); cell = ''; hasCell = false; endedQuote = false;
      if (row.length > 100) throw new ApiError(422, 'INVALID_CSV', 'At most 100 CSV columns are supported.');
      i++;
    } else {
      i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
      flushRow();
    }
  }
  flushRow();
  if (yielded < 2) throw new ApiError(422, 'INVALID_CSV', 'Include a header and at least one contact row.');
  return yielded;
}
class JsonArrayBuilder {
  private chunks: string[] = ['['];
  private pending: string[] = [];
  count = 0;
  push(itemJson: string) {
    this.pending.push((this.count++ ? ',' : '') + itemJson);
    if (this.pending.length >= 512) { this.chunks.push(this.pending.join('')); this.pending.length = 0; }
  }
  finish(): string {
    if (this.pending.length) { this.chunks.push(this.pending.join('')); this.pending.length = 0; }
    this.chunks.push(']');
    const out = this.chunks.join('');
    this.chunks.length = 0;
    return out;
  }
}
function previewImport(input: z.infer<typeof ImportInput>, hygiene: HygieneLists) {
  const mapping = Object.entries(input.mapping);
  let headerLen = 0, emailIdx = -1, nameIdx: number | undefined;
  let propCols: ReadonlyArray<readonly ['firstName' | 'plan' | 'country', number]> = [];
  const rows = new JsonArrayBuilder(), failures = new JsonArrayBuilder(), seen = new Set<string>(), risky = { total: 0, byReason: noRisks() };
  // Rows whose domain the DNS check decides (nothing the address says, or a role name a dead domain outranks), by domain.
  const domains = new Map<string, { plain: number; role: number }>();
  forEachCsvRow(input.csv, (values, rowNum) => {
    if (rowNum === 1) {
      const headers = values.map(h => h.trim());
      if (new Set(headers).size !== headers.length || headers.some(h => !h)) throw new ApiError(422, 'INVALID_CSV_HEADERS', 'CSV headers must be nonempty and unique.');
      const columnIndex = new Map<string, number>();
      for (const [field, column] of mapping) {
        const idx = headers.indexOf(column);
        if (idx < 0) throw new ApiError(422, 'INVALID_IMPORT_MAPPING', `The mapped column for ${field} was not found.`, `mapping.${field}`);
        columnIndex.set(field, idx);
      }
      headerLen = headers.length; emailIdx = columnIndex.get('email')!; nameIdx = columnIndex.get('name');
      propCols = (['firstName', 'plan', 'country'] as const).flatMap(key => {
        const idx = columnIndex.get(key);
        return idx !== undefined ? [[key, idx] as const] : [];
      });
      return;
    }
    if (values.length !== headerLen) { failures.push(JSON.stringify({ row: rowNum, field: 'row', message: 'The row has a different number of columns than the header.' })); return; }
    const rawEmail = values[emailIdx]!.trim();
    const rawName = nameIdx !== undefined ? values[nameIdx]!.trim() : undefined;
    let fastOk = validAddress(rawEmail) && (rawName === undefined || rawName.length <= 200);
    let propJson = '';
    if (fastOk) {
      for (let j = 0; j < propCols.length; j++) {
        const [key, idx] = propCols[j]!;
        const val = values[idx]!.trim();
        if (val.length > 2000) { fastOk = false; break; }
        propJson += (j ? ',' : '') + `"${key}":${JSON.stringify(val)}`;
      }
    }
    let email: string, rowJson: string;
    if (fastOk) {
      email = rawEmail.toLowerCase();
      rowJson = rawName !== undefined
        ? `{"row":${rowNum},"email":${JSON.stringify(email)},"name":${JSON.stringify(rawName)},"properties":{${propJson}}}`
        : `{"row":${rowNum},"email":${JSON.stringify(email)},"properties":{${propJson}}}`;
    } else {
      const properties: Record<string, string> = {};
      for (let j = 0; j < propCols.length; j++) { const [key, idx] = propCols[j]!; properties[key] = values[idx]!.trim(); }
      const parsed = ContactInput.safeParse({ email: rawEmail, name: rawName, properties });
      if (!parsed.success) {
        for (const issue of parsed.error.issues) failures.push(JSON.stringify({ row: rowNum, field: issue.path.join('.'), message: issue.message }));
        return;
      }
      email = parsed.data.email;
      rowJson = JSON.stringify(parsed.data.name !== undefined ? { row: rowNum, email, name: parsed.data.name, properties: parsed.data.properties } : { row: rowNum, email, properties: parsed.data.properties });
    }
    if (seen.has(email)) { failures.push(JSON.stringify({ row: rowNum, field: 'email', message: 'Duplicate normalized email within this import.' })); return; }
    seen.add(email);
    // The row keeps what its address says (list hygiene): commit stores it on a new contact.
    const risk = classifyAddress(email, hygiene)?.risk;
    if (risk) { risky.byReason[risk]++; risky.total++; rowJson = `${rowJson.slice(0, -1)},"risk":"${risk}"}`; }
    if (!risk || risk === 'role') { const d = domainOf(email), n = domains.get(d) ?? { plain: 0, role: 0 }; n[risk ? 'role' : 'plain']++; domains.set(d, n); }
    rows.push(rowJson);
  });
  seen.clear();
  return { rowsJson: rows.finish(), errorsJson: failures.finish(), rowCount: rows.count, risky, domains };
}
export const importStream = { idleMs: MEMORY_LIMITS.streamIdleMs, maxMs: MEMORY_LIMITS.streamMaxMs };
const importStreamBytes = (chars: number) => Math.min(12 * 1024 * 1024, Math.max(256 * 1024, Math.ceil(chars)));

// Stream large import JSON responses one 64 KiB chunk at a time on pull(), holding a shrunk self-reclaiming memory lease.
function streamImportResponse(c: Ctx, meta: ImportMeta, rowsJson: string, errorsJson: string, status: 200 | 201, subscribed?: number, lease?: MemoryLease): Response {
  lease?.shrink(importStreamBytes(rowsJson.length + errorsJson.length));
  const parts = [
    `{"id":${JSON.stringify(meta.id)},"workspaceId":${JSON.stringify(meta.workspaceId)},"listId":${JSON.stringify(meta.listId)},"status":${JSON.stringify(meta.status)},"rows":`,
    rowsJson,
    `,"errors":`,
    errorsJson,
    `,"imported":${meta.imported},"rowsRetained":${meta.rowsScrubbedAt === null},"errorsRetained":${meta.errorsScrubbedAt === null},"risky":${JSON.stringify(receiptRisk(meta.riskSummary))},"createdAt":${JSON.stringify(meta.createdAt)},"updatedAt":${JSON.stringify(meta.updatedAt)}${subscribed !== undefined ? `,"subscribed":${subscribed}` : ''}}`,
  ];
  return streamTextPartsResponse(c, parts, status, { lease, idleMs: importStream.idleMs, maxMs: importStream.maxMs });
}

export function registerAudienceImports(app: App) {
  app.openapi(createRoute({ method: 'post', path: '/v1/contact-imports', operationId: 'previewContactImport', tags: ['Audience'], security, description: `Persist a preview before commit. Feature limit: 5 MiB UTF-8 CSV, 50,000 rows, 100 columns per import; preview and commit a larger file in parts of that size (the dashboard does this for files up to 1,000,000 rows and 100 MiB). Map headers explicitly. Valid rows can commit alongside a retained row-error report. Imports never lift suppression; consent changes only when the commit attests it. Each workspace keeps at most ${IMPORT_OPEN_PREVIEW_CAP} uncommitted previews (oldest evicted) and allows ${IMPORT_PREVIEW_RATE_PER_MINUTE} previews per minute.`, request: { body: json(ImportInput) }, responses: { 201: response(Import), ...errors } }), async c => {
    const input = c.req.valid('json'), identity = actor(c, input.listId ? 'manage' : 'editContent');
    if (input.listId) await findList(c.env.db, identity, input.listId);
    if (!await chargeBudget(c.env, identity.workspaceId, 'imports:preview', IMPORT_PREVIEW_RATE_PER_MINUTE)) {
      c.header('Retry-After', '60');
      throw new ApiError(429, 'IMPORT_PREVIEW_RATE_LIMITED', `This workspace allows ${IMPORT_PREVIEW_RATE_PER_MINUTE} contact import previews per minute. Retry after the window resets.`, undefined, true);
    }
    // Reuse the outer self-reclaiming pre-parse lease from app.ts (or acquire one if invoked directly) and shrink it
    // when handing off to streamImportResponse.
    const reserveBytes = importPreviewReservationBytes(input.csv.length);
    const outerLease = c.get('importLease');
    let ownLease: MemoryLease | undefined;
    if (!outerLease) {
      try {
        ownLease = await reserveMemory(reserveBytes, { route: 'import.preview', workspaceId: identity.workspaceId, signal: c.req.raw.signal, idleMs: 15_000, maxMs: 45_000, wsBusyCode: 'IMPORT_CONCURRENCY_LIMIT', busyCode: 'IMPORT_CONCURRENCY_LIMIT' });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return new Response(null, { status: 499 }) as never;
        if (error instanceof ApiError && (error.status === 429 || error.status === 503)) c.header('Retry-After', '1');
        throw error;
      }
    }
    const lease = outerLease ?? ownLease!;
    let transferred = false;
    try {
      const built = await runInMemoryScope(reserveBytes, async () => {
        if (c.req.raw.signal?.aborted) return null;
        const hygiene = await hygieneLists(c.env.db), { rowsJson, errorsJson, risky, domains } = previewImport(input, hygiene);
        // The domains' DNS verdicts (cached, else looked up for a few seconds; the rest are queued and the resolver flags
        // their contacts once imported). The summary counts them; the commit stores what is known by then.
        for (const [domain, risk] of await domainRisks(c.env, hygiene, domains.keys(), Date.now() + IMPORT_DNS_MS)) {
          const n = domains.get(domain)!;
          risky.byReason[risk] += n.plain + n.role; risky.byReason.role -= n.role; risky.total += n.plain;
        }
        const newId = id('imp');
        const meta = await c.env.db.transaction(async tx => {
          // Transaction-scoped advisory lock (supported by Hyperdrive and PgBouncer transaction pooling) keeps the
          // newest IMPORT_OPEN_PREVIEW_CAP uncommitted previews per workspace even under concurrent previews.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(275818, hashtext(${identity.workspaceId}))`);
          const [row] = await tx.insert(imports).values({ id: newId, ...scopeValues(identity), listId: input.listId, riskSummary: risky, rows: sql`${rowsJson}::jsonb` as unknown as never, errors: sql`${errorsJson}::jsonb` as unknown as never, createdAt: sql`clock_timestamp()` as unknown as string, updatedAt: sql`clock_timestamp()` as unknown as string }).returning(importMetaColumns);
          await tx.execute(sql`DELETE FROM audience_imports WHERE workspace_id = ${identity.workspaceId} AND status = 'preview' AND id <> ${newId}
            AND id IN (SELECT id FROM audience_imports WHERE workspace_id = ${identity.workspaceId} AND status = 'preview' AND id <> ${newId} ORDER BY created_at DESC, id DESC OFFSET ${IMPORT_OPEN_PREVIEW_CAP - 1})`);
          return row!;
        });
        return { meta, rowsJson, errorsJson };
      }, () => lease.touch());
      if (!built) return new Response(null, { status: 499 }) as never;
      transferred = true;
      if (outerLease) c.set('importLeaseTransferred', true);
      return streamImportResponse(c, built.meta, built.rowsJson, built.errorsJson, 201, undefined, lease) as never;
    } finally {
      if (!transferred && ownLease) ownLease.release();
    }
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/contact-imports', operationId: 'listContactImports', tags: ['Audience'], security, request: { query: PageQuery }, responses: { 200: response(page(Import.omit({ rows: true, errors: true }))), ...errors } }), async c => {
    const identity = actor(c), query = c.req.valid('query'); const rows = await c.env.db.select(importMetaColumns).from(imports).where(and(scope(imports, identity), query.cursor ? gt(imports.id, query.cursor) : undefined)).orderBy(asc(imports.id)).limit(query.limit + 1); const result = paginate(rows, query.limit); return c.json({ ...result, data: result.data.map(importSummary) }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/contact-imports/{id}', operationId: 'getContactImport', tags: ['Audience'], security, description: 'Read one import preview or committed import report. Committed row payloads are retained briefly after commit (rowsRetained is false and rows is [] once scrubbed; imported keeps the count); per-row errors are retained longer (errorsRetained is false once scrubbed).', request: { params: IdParams }, responses: { 200: response(Import), ...errors } }), async c => {
    const identity = actor(c);
    const reserveBytes = IMPORT_GET_RESERVATION_BYTES;
    let lease: MemoryLease;
    try {
      lease = await reserveMemory(reserveBytes, { route: 'import.read', workspaceId: identity.workspaceId, signal: c.req.raw.signal, maxWorkspaceBytes: 32 * 1024 * 1024, wsBusyCode: 'IMPORT_CONCURRENCY_LIMIT', busyCode: 'IMPORT_CONCURRENCY_LIMIT' });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return new Response(null, { status: 499 }) as never;
      if (error instanceof ApiError && (error.status === 429 || error.status === 503)) c.header('Retry-After', '1');
      throw error;
    }
    let transferred = false;
    try {
      const [row] = await runInMemoryScope(reserveBytes, () => c.env.db.select({ ...importMetaColumns, rowsText: sql<string>`${imports.rows}::text`, errorsText: sql<string>`${imports.errors}::text` }).from(imports).where(and(scope(imports, identity), eq(imports.id, c.req.valid('param').id))).limit(1), () => lease.touch());
      if (!row) importNotFound();
      transferred = true;
      return streamImportResponse(c, row, row.rowsText, row.errorsText, 200, undefined, lease) as never;
    } finally {
      if (!transferred) lease.release();
    }
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/contact-imports/{id}/commit', operationId: 'commitContactImport', tags: ['Audience'], security, description: 'Imports every valid row of a previewed import. Without consent, imported contacts keep their consent decision (new contacts have none, so campaigns skip them). With consent, everyone imported who had no decision is marked subscribed with your evidence. A repeated commit changes nothing. One import commits at a time per workspace (503 IMPORT_COMMIT_BUSY if another is running; retryable).', request: { params: IdParams, body: { ...json(ImportCommit), required: false } }, responses: { 200: response(CommittedImport), ...errors } }), async c => {
    const identity = actor(c, 'editContent'), importId = c.req.valid('param').id, consent = c.req.valid('json').consent;
    const reserveBytes = IMPORT_COMMIT_RESERVATION_BYTES;
    let lease: MemoryLease;
    try {
      lease = await reserveMemory(reserveBytes, { route: 'import.commit', workspaceId: identity.workspaceId, signal: c.req.raw.signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return new Response(null, { status: 499 }) as never;
      if (error instanceof ApiError && (error.status === 429 || error.status === 503)) c.header('Retry-After', '1');
      throw error;
    }
    let transferred = false;
    try {
      const result = await runInMemoryScope(reserveBytes, async () => {
        if (c.req.raw.signal?.aborted) return null;
        return c.env.db.transaction(async tx => {
          // One commit at a time per workspace (transaction-scoped try-lock: supported by Hyperdrive and PgBouncer
          // transaction mode, released automatically at COMMIT/ROLLBACK), matching AUDIENCE_CAPTURE_BUSY.
          if (!(await tx.execute(sql`SELECT 1 WHERE pg_try_advisory_xact_lock(275817, hashtext(${identity.workspaceId}))`)).rowCount)
            throw new ApiError(503, 'IMPORT_COMMIT_BUSY', 'Another contact import is committing in this workspace; retry when it finishes.', undefined, true);
          const [job] = await tx.select({ ...importMetaColumns, rowCount: sql<number>`jsonb_array_length(${imports.rows})::int` }).from(imports).where(and(scope(imports, identity), eq(imports.id, importId))).limit(1).for('update');
          if (!job) importNotFound();
          if (job.listId) actor(c, 'manage');
          if (job.status === 'committed') {
            const [full] = await tx.select({ rowsText: sql<string>`${imports.rows}::text`, errorsText: sql<string>`${imports.errors}::text` }).from(imports).where(and(scope(imports, identity), eq(imports.id, importId))).limit(1);
            return { meta: job, rowsText: full!.rowsText, errorsText: full!.errorsText, subscribed: 0 };
          }
          // A share lock keeps the list from being changed or deleted mid-commit.
          if (job.listId) { const [list] = await tx.select({ id: lists.id }).from(lists).where(and(scope(lists, identity), eq(lists.id, job.listId))).limit(1).for('share'); if (!list) notFound('List'); }
          // Domain verdicts count only while the checks are on (NIGHTMAIL_HYGIENE_DNS), as everywhere else.
          const now = new Date().toISOString(), dnsOn = !!c.env.config.hygieneDnsUrl;
          let subscribed = 0;
          let sampleContactIds: string[] = [];
          let riskSummary = riskyFrom(null);
          if (job.rowCount > 0) {
            // Statement 1: upsert contacts with time-ordered UUIDv7 IDs (row_id('con') format), check merged property
            // limits (<= 50) in SQL, and — when consent is attested — insert brand-new contacts directly as 'subscribed'
            // (xmax = 0) with their consent audit and folded operation.publishBatch jobs. Kept separate from
            // audience_list_members inserts (Statement 3) so statement triggers on audience_contacts (e.g. restoring a
            // deleted contact) and audience_list_members never fire in the same statement and double-count.
            const initialConsent = consent ? 'subscribed' : 'unknown';
            const tsHex = Date.now().toString(16).padStart(12, '0');
            const { rows: [step1] } = await tx.execute<{ bad_row: number | null; inserted_subscribed: number; jobs_enqueued: number; existing_unknown_ids: string[] | null; contact_ids: string[] | null; sample_ids: string[] | null; risky: Record<string, number> | null }>(sql`
              WITH incoming AS (
                SELECT (r->>'row')::int AS row_num, r->>'email' AS email, r->>'name' AS name, coalesce(r->'properties', '{}'::jsonb) AS properties, r->>'risk' AS risk,
                  m.verdict AS domain_verdict
                FROM audience_imports i CROSS JOIN LATERAL jsonb_array_elements(i.rows) r
                  LEFT JOIN hygiene_mail_domains m ON m.domain = split_part(r->>'email', '@', 2)
                WHERE i.workspace_id = ${identity.workspaceId} AND i.id = ${importId}
              ), upserted AS (
                -- A new contact gets the risk its preview found, its domain's verdict as checked by now (a domain that can't
                -- receive mail outranks a role name), else dead when the address bounced elsewhere; an existing contact keeps
                -- its own (and its owner's allowance), unless it was deleted and comes back new.
                INSERT INTO audience_contacts AS c (id, workspace_id, email, name, properties, marketing_consent, risk)
                SELECT 'con_' || ${tsHex}::text || '7' || substr(replace(gen_random_uuid()::text, '-', ''), 14), ${identity.workspaceId}, email, name, properties, ${initialConsent},
                  CASE WHEN risk IS NOT NULL AND risk <> 'role' THEN risk WHEN ${dnsOn} AND domain_verdict = 'no_mail' THEN 'no_mail_domain'
                    WHEN risk = 'role' THEN risk
                    WHEN ${bouncedElsewhere(sql`incoming.email`, sql`${identity.workspaceId}::text`)} THEN 'dead' END
                FROM incoming ORDER BY email
                ON CONFLICT ON CONSTRAINT audience_contacts_email_scope DO UPDATE SET name = coalesce(excluded.name, c.name), properties = c.properties || excluded.properties, deleted_at = NULL, updated_at = ${now},
                  risk = CASE WHEN c.deleted_at IS NULL THEN c.risk ELSE excluded.risk END, risk_allowed = c.risk_allowed AND c.deleted_at IS NULL
                RETURNING c.id, c.email, c.properties, (xmax = 0) AS inserted, c.marketing_consent, c.risk, c.risk_allowed
              ), bad AS (
                SELECT inc.row_num FROM upserted u JOIN incoming inc ON inc.email = u.email
                WHERE (NOT u.inserted AND (SELECT count(*) FROM jsonb_object_keys(u.properties)) > ${CONTACT_PROPERTIES_MAX_KEYS})
                  OR octet_length(u.properties::text) > ${CONTACT_PROPERTIES_DB_MAX_BYTES}
                ORDER BY inc.row_num LIMIT 1
              )${consent ? sql`, audited AS (
                INSERT INTO audience_consent_audit (id, workspace_id, contact_id, email, status, source, policy_version, evidence, actor_key_id, import_id, occurred_at)
                SELECT 'cns_' || ${tsHex}::text || '7' || substr(replace(gen_random_uuid()::text, '-', ''), 14), ${identity.workspaceId}, id, email, 'subscribed', 'import', ${consent.policyVersion ?? null}, ${consent.evidence}, ${identity.keyId}, ${job.id}, ${now}
                FROM upserted WHERE inserted
                RETURNING id, contact_id
              ), numbered AS (
                SELECT id, contact_id, ((row_number() OVER () - 1) / 100) AS grp FROM audited
              ), batched AS (
                SELECT grp,
                  jsonb_build_object('events', jsonb_agg(jsonb_build_object(
                    'id', id, 'type', 'contact.subscription_changed', 'createdAt', ${now}::text, 'workspaceId', ${identity.workspaceId}::text, 'region', NULL,
                    'data', jsonb_build_object('contactId', contact_id, 'status', 'subscribed', 'source', 'import')
                  ))) AS payload
                FROM (SELECT grp, id, contact_id FROM numbered ORDER BY grp) s GROUP BY grp
              ), enqueued AS (
                INSERT INTO jobs (id, workspace_id, type, payload)
                SELECT 'job_' || ${tsHex}::text || '7' || substr(replace(gen_random_uuid()::text, '-', ''), 14), ${identity.workspaceId}, 'operation.publishBatch', payload FROM batched
                RETURNING 1
              )` : sql``}
              SELECT (SELECT row_num FROM bad) AS bad_row,
                ${consent ? sql`(SELECT count(*)::int FROM audited)` : sql`0`} AS inserted_subscribed,
                ${consent ? sql`(SELECT count(*)::int FROM enqueued)` : sql`0`} AS jobs_enqueued,
                ${consent ? sql`ARRAY(SELECT id FROM upserted WHERE NOT inserted AND marketing_consent = 'unknown' ORDER BY id)` : sql`NULL::text[]`} AS existing_unknown_ids,
                ${job.listId ? sql`ARRAY(SELECT id FROM upserted)` : sql`NULL::text[]`} AS contact_ids,
                ARRAY(SELECT id FROM upserted ORDER BY hashtextextended(id, 0) LIMIT ${IMPORT_SAMPLE_CONTACT_IDS}) AS sample_ids,
                (SELECT jsonb_object_agg(risk, n) FROM (SELECT risk, count(*)::int AS n FROM upserted WHERE risk IS NOT NULL AND NOT risk_allowed GROUP BY risk) r) AS risky`);
            if (step1?.bad_row != null) throw new ApiError(422, 'IMPORT_PROPERTIES_INVALID', `Row ${step1.bad_row}: merged contact properties exceed the supported limits. No rows were imported.`, `rows.${step1.bad_row}.properties`);
            sampleContactIds = step1?.sample_ids ?? [];
            riskSummary = riskyFrom(step1?.risky ?? null);
            subscribed += step1?.inserted_subscribed ?? 0;
            noteEnqueued(step1?.jobs_enqueued ?? 0);
            // Statement 2 (only when re-imported existing contacts had marketing_consent = 'unknown'): upgrade them
            // by primary key, write consent audit, and fold publishBatch jobs into one insert.
            if (consent && step1?.existing_unknown_ids?.length) {
              const { rows: [step2] } = await tx.execute<{ subscribed: number; jobs_enqueued: number }>(sql`
                WITH changed AS (
                  UPDATE audience_contacts c SET marketing_consent = 'subscribed', updated_at = ${now}
                  WHERE c.workspace_id = ${identity.workspaceId} AND c.id = ANY(${sql.param(step1.existing_unknown_ids)}::text[]) AND c.marketing_consent = 'unknown'
                  RETURNING c.id, c.email
                ), audited AS (
                  INSERT INTO audience_consent_audit (id, workspace_id, contact_id, email, status, source, policy_version, evidence, actor_key_id, import_id, occurred_at)
                  SELECT 'cns_' || ${tsHex}::text || '7' || substr(replace(gen_random_uuid()::text, '-', ''), 14), ${identity.workspaceId}, id, email, 'subscribed', 'import', ${consent.policyVersion ?? null}, ${consent.evidence}, ${identity.keyId}, ${job.id}, ${now} FROM changed
                  RETURNING id, contact_id
                ), numbered AS (
                  SELECT id, contact_id, ((row_number() OVER () - 1) / 100) AS grp FROM audited
                ), batched AS (
                  SELECT grp,
                    jsonb_build_object('events', jsonb_agg(jsonb_build_object(
                      'id', id, 'type', 'contact.subscription_changed', 'createdAt', ${now}::text, 'workspaceId', ${identity.workspaceId}::text, 'region', NULL,
                      'data', jsonb_build_object('contactId', contact_id, 'status', 'subscribed', 'source', 'import')
                    ))) AS payload
                  FROM (SELECT grp, id, contact_id FROM numbered ORDER BY grp) s GROUP BY grp
                ), enqueued AS (
                  INSERT INTO jobs (id, workspace_id, type, payload)
                  SELECT 'job_' || ${tsHex}::text || '7' || substr(replace(gen_random_uuid()::text, '-', ''), 14), ${identity.workspaceId}, 'operation.publishBatch', payload FROM batched
                  RETURNING 1
                )
                SELECT (SELECT count(*)::int FROM audited) AS subscribed, (SELECT count(*)::int FROM enqueued) AS jobs_enqueued`);
              subscribed += step2?.subscribed ?? 0;
              noteEnqueued(step2?.jobs_enqueued ?? 0);
            }
            // Statement 3: add list memberships from Statement 1's sorted contact IDs once every contact is in its
            // final state (avoids re-scanning audience_contacts and keeps audience_members_added in its own statement
            // so statement triggers on audience_contacts and audience_list_members compose without double-counting).
            if (job.listId && step1?.contact_ids?.length) {
              await tx.execute(sql`
                INSERT INTO audience_list_members (workspace_id, list_id, contact_id)
                SELECT ${identity.workspaceId}, ${job.listId}::text, cid
                FROM unnest(${sql.param(step1.contact_ids)}::text[]) AS cid
                ON CONFLICT DO NOTHING`);
            }
          }
          const [updated] = await tx.update(imports).set({ status: 'committed', imported: job.rowCount, sampleContactIds, riskSummary, consentLinkedAt: now, updatedAt: now }).where(and(scope(imports, identity), eq(imports.id, job.id))).returning({ ...importMetaColumns, rowsText: sql<string>`${imports.rows}::text`, errorsText: sql<string>`${imports.errors}::text` });
          return { meta: updated!, rowsText: updated!.rowsText, errorsText: updated!.errorsText, subscribed };
        });
      });
      if (!result) return new Response(null, { status: 499 }) as never;
      transferred = true;
      return streamImportResponse(c, result.meta, result.rowsText, result.errorsText, 200, result.subscribed, lease) as never;
    } catch (error) {
      if (isContactSizeCheckViolation(error)) throw new ApiError(422, 'IMPORT_PROPERTIES_INVALID', 'Merged contact properties exceed the 50-property or 16 KiB JSON limit. No rows were imported.', 'rows');
      if (statementTimedOut(error)) throw new ApiError(503, 'IMPORT_COMMIT_TIMEOUT', 'The contact import commit ran out of time and nothing was imported. Retry the commit.', undefined, true);
      throw error;
    } finally {
      if (!transferred) lease.release();
    }
  });
}
