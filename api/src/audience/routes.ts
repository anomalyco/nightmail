import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, isNull, notInArray, sql, gt, asc } from 'drizzle-orm';
import type { App, DbExecutor } from '../core/types.js';
import { actor } from '../core/access.js';
import { errors, ApiError, notFound } from '../core/errors.js';
import { security, readLimitNote, response, page, budgetedRead, readLimit, json, rowId, IdParams, PageQuery, id } from '../core/http.js';
import { productName } from '../brand.js';
import { contacts, listMembers, lists, consentAudit, segments } from '../db/audience.js';
import { contactTopicStates, recordTopicChoices } from '../topics.js';
import { buildBoundedPageJson } from '../read-bounds.js';
import { riskFor, type Risk } from '../list-hygiene.js';
import { AUDIENCE_READ_SECONDS, ContactQuery, ContactRead, withAudienceReadMemory, findList, CONTACT_LIST_IDS_PAGE_MAX, AUDIENCE_READ_MAX_BYTES, ContactInput, Contact, scopeValues, lockLists, isContactSizeCheckViolation, contactBody, ContactDetail, findContact, CONTACT_LIST_IDS_SINGLE_MAX, ContactPatch, scope, Deleted, ConsentInput, Audit, paginate, ListQuery, ListRead, listColumns, ListInput, List, SearchQuery, Segment, SegmentInput, findSegment, Counts } from './schemas.js';
import { boundedContactPage, readContacts, recordConsent, searchText, readLists, lockContacts } from './consent.js';
import { PREVIEW_READ_SECONDS, previewSegmentCounts } from './segments.js';
import { registerAudienceImports } from './imports.js';

export function registerAudience(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/contacts', operationId: 'listContacts', tags: ['Audience'], security, description: `Active contacts with current list IDs. A search that is one complete email address returns that contact (exact, any case). Any other search is a case-insensitive literal substring of the email or name. Consent and suppression filters are independent. Pages are also bounded by response size and may return fewer than limit contacts; follow nextCursor while non-null. ${readLimitNote(AUDIENCE_READ_SECONDS)}`, request: { query: ContactQuery }, responses: { 200: response(page(ContactRead)), ...errors } }), async c => {
    const identity = actor(c), query = c.req.valid('query');
    return await withAudienceReadMemory(c, async () => {
      const { items, hasMore } = await budgetedRead(c.env.db, async tx => {
        if (query.listId) await findList(tx, identity, query.listId);
        const { rows, hasMore: more } = await boundedContactPage(tx, identity, query);
        return { items: await readContacts(tx, identity, rows, CONTACT_LIST_IDS_PAGE_MAX), hasMore: more };
      }, readLimit(AUDIENCE_READ_SECONDS));
      const { json: body } = buildBoundedPageJson(items, hasMore, AUDIENCE_READ_MAX_BYTES);
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8' } });
    }) as never;
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/contacts', operationId: 'createContact', tags: ['Audience'], security, request: { body: json(ContactInput) }, responses: { 201: response(Contact), ...errors } }), async c => {
    const identity = actor(c, 'editContent'), { listIds, ...input } = c.req.valid('json');
    const desiredLists = listIds ? [...new Set(listIds)].sort() : [];
    if (desiredLists.length) actor(c, 'manage');
    const risk = await riskFor(c.env, input.email, identity.workspaceId) as unknown as Risk;
    let contact: typeof contacts.$inferSelect | undefined;
    try {
      const createRow = async (db: DbExecutor) => {
        const [created] = await db.insert(contacts).values({ id: rowId('con'), ...scopeValues(identity), ...input, risk }).onConflictDoNothing().returning();
        if (!created) throw new ApiError(409, 'CONTACT_EXISTS', 'This address already has a contact or retained consent record. Use imports to restore a deleted contact without changing consent.');
        return created;
      };
      contact = desiredLists.length
        ? await c.env.db.transaction(async tx => {
            await lockLists(tx, identity, desiredLists);
            const created = await createRow(tx);
            await tx.insert(listMembers).values(desiredLists.map(listId => ({ ...scopeValues(identity), listId, contactId: created.id }))).onConflictDoNothing();
            return created;
          })
        : await createRow(c.env.db);
    } catch (err) {
      if (isContactSizeCheckViolation(err)) throw new ApiError(422, 'VALIDATION_FAILED', 'Contact properties must total at most 16 KiB of JSON.', 'properties');
      throw err;
    }
    return c.json(contactBody(contact), 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/contacts/{id}', operationId: 'getContact', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(ContactDetail), ...errors } }), async c => {
    const identity = actor(c), row = await findContact(c.env.db, identity, c.req.valid('param').id);
    const [[contact], states] = await Promise.all([readContacts(c.env.db, identity, [row], CONTACT_LIST_IDS_SINGLE_MAX), contactTopicStates(c.env.db, identity.workspaceId, row.id)]);
    return c.json({ ...contact!, topics: states.map(({ description: _, ...topic }) => topic) }, 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/contacts/{id}', operationId: 'updateContact', tags: ['Audience'], security, request: { params: IdParams, body: json(ContactPatch) }, responses: { 200: response(Contact), ...errors } }), async c => {
    const identity = actor(c, 'editContent'), contactId = c.req.valid('param').id, { listIds, ...input } = c.req.valid('json'), found = await findContact(c.env.db, identity, contactId);
    // Sending to a risky address anyway is an owner's or admin's call (manage), not every member's who edits contacts.
    if (input.riskAllowed !== undefined) actor(c, 'manage');
    if (input.riskAllowed !== undefined && !found.risk) throw new ApiError(409, 'CONTACT_NOT_RISKY', 'This contact is not flagged as risky, so there is nothing to allow.', 'riskAllowed');
    let contact: typeof contacts.$inferSelect | undefined;
    try {
      const updateRow = async (db: DbExecutor) => {
        // The allowance is for the risk the caller saw: one the hourly pass changed meanwhile stays skipped.
        const [updated] = await db.update(contacts).set({ ...input, updatedAt: new Date().toISOString() }).where(and(scope(contacts, identity), eq(contacts.id, contactId), isNull(contacts.deletedAt), input.riskAllowed !== undefined ? eq(contacts.risk, found.risk!) : undefined)).returning();
        return updated ?? notFound('Contact');
      };
      if (listIds !== undefined) {
        const desiredLists = [...new Set(listIds)].sort();
        const canManage = identity.permissions.includes('manage');
        contact = await c.env.db.transaction(async tx => {
          // Strict lock order everywhere: lists (FOR SHARE, asc id) -> contacts (UPDATE) -> listMembers.
          // Callers with manage lock desiredLists before contacts; callers without manage never lock lists
          // and roll back with 403 after reading memberships under the contact row lock if they differ.
          if (canManage) await lockLists(tx, identity, desiredLists);
          const updated = await updateRow(tx);
          const current = await tx.select({ listId: listMembers.listId }).from(listMembers).innerJoin(lists, and(eq(lists.workspaceId, listMembers.workspaceId), eq(lists.id, listMembers.listId))).where(and(scope(listMembers, identity), eq(listMembers.contactId, contactId)));
          const currentSet = new Set(current.map(row => row.listId));
          const changed = desiredLists.length !== currentSet.size || desiredLists.some(listId => !currentSet.has(listId));
          if (changed) {
            if (!canManage) actor(c, 'manage');
            await tx.delete(listMembers).where(and(scope(listMembers, identity), eq(listMembers.contactId, contactId), desiredLists.length ? notInArray(listMembers.listId, desiredLists) : undefined));
            if (desiredLists.length) await tx.insert(listMembers).values(desiredLists.map(listId => ({ ...scopeValues(identity), listId, contactId }))).onConflictDoNothing();
          }
          return updated;
        });
      } else {
        contact = await updateRow(c.env.db);
      }
    } catch (err) {
      if (isContactSizeCheckViolation(err)) throw new ApiError(422, 'VALIDATION_FAILED', 'Contact properties must total at most 16 KiB of JSON.', 'properties');
      throw err;
    }
    return c.json(contactBody(contact), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/contacts/{id}', operationId: 'deleteContact', tags: ['Audience'], security, description: 'Remove contact profile and memberships, retaining minimal consent/suppression to prevent accidental re-enrollment.', request: { params: IdParams }, responses: { 200: response(Deleted), ...errors } }), async c => {
    const identity = actor(c, 'editContent'), contactId = c.req.valid('param').id;
    await c.env.db.transaction(async tx => {
      await findContact(tx, identity, contactId);
      await tx.update(contacts).set({ deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), name: null, properties: {} }).where(and(scope(contacts, identity), eq(contacts.id, contactId)));
      await tx.delete(listMembers).where(and(scope(listMembers, identity), eq(listMembers.contactId, contactId)));
    });
    return c.json({ id: contactId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/contacts/{id}/consent', operationId: 'updateContactConsent', tags: ['Consent'], security, description: `Set marketing subscription status, or with topicId the contact's choice about one topic (its sends reach a contact only while marketing consent is subscribed too; each topic change is a contact.subscription_changed event with topicId). Look up a contact’s ID by email first with listContacts (GET /v1/contacts?email=<address>). Source, policy version, evidence and occurrence time are optional audit context; ${productName} records the actor and current time when omitted. Does not lift delivery suppression. Profile edits cannot establish consent; an import can only when its commit attests consent.`, request: { params: IdParams, body: json(ConsentInput) }, responses: { 200: response(Contact), ...errors } }), async c => {
    const identity = actor(c, 'editContent'), contactId = c.req.valid('param').id, input = c.req.valid('json');
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const source = input.source ?? (identity.credential === 'dashboard' ? 'dashboard' : identity.credential === 'mcp' ? 'mcp' : identity.credential === 'agentToken' ? 'agent-token' : 'api');
    const contact = await c.env.db.transaction(async tx => {
      const [existing] = await tx.select().from(contacts).where(and(scope(contacts, identity), eq(contacts.id, contactId), isNull(contacts.deletedAt))).limit(1).for('update');
      if (!existing) return notFound('Contact');
      if (input.topicId) {
        await recordTopicChoices(tx, identity.workspaceId, existing, [{ topicId: input.topicId, subscribed: input.status === 'subscribed' }], { source, policyVersion: input.policyVersion, evidence: input.evidence, occurredAt, actorKeyId: identity.keyId }, input.confirmResubscribe);
        return existing;
      }
      if (existing.marketingConsent === 'unsubscribed' && input.status === 'subscribed' && !input.confirmResubscribe) throw new ApiError(409, 'RESUBSCRIBE_CONFIRMATION_REQUIRED', 'Explicitly confirm renewed verifiable consent to replace a prior opt-out.', 'confirmResubscribe');
      if (input.status === 'subscribed') {
        const [latest] = await tx.select().from(consentAudit).where(and(scope(consentAudit, identity), eq(consentAudit.contactId, contactId), isNull(consentAudit.topicId))).orderBy(sql`${consentAudit.occurredAt} DESC`).limit(1);
        if (latest && Date.parse(occurredAt) <= Date.parse(latest.occurredAt)) throw new ApiError(409, 'STALE_CONSENT', 'Renewed consent must be newer than the prior consent decision.');
      }
      return recordConsent(tx, identity, existing, { status: input.status, source, policyVersion: input.policyVersion, evidence: input.evidence, occurredAt, actorKeyId: identity.keyId });
    }); return c.json(contactBody(contact), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/contacts/{id}/consent', operationId: 'listContactConsentEvents', tags: ['Consent'], security, request: { params: IdParams, query: PageQuery }, responses: { 200: response(page(Audit)), ...errors } }), async c => {
    const identity = actor(c), contactId = c.req.valid('param').id, query = c.req.valid('query'); await findContact(c.env.db, identity, contactId);
    const rows = await c.env.db.select().from(consentAudit).where(and(scope(consentAudit, identity), eq(consentAudit.contactId, contactId), query.cursor ? gt(consentAudit.id, query.cursor) : undefined)).orderBy(asc(consentAudit.id)).limit(query.limit + 1);
    return c.json(paginate(rows, query.limit), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/lists', operationId: 'listContactLists', tags: ['Audience'], security, request: { query: ListQuery }, responses: { 200: response(page(ListRead)), ...errors } }), async c => {
    const identity = actor(c), query = c.req.valid('query'); const rows = await c.env.db.select(listColumns).from(lists).where(and(scope(lists, identity), query.search ? searchText(lists.name, query.search) : undefined, query.cursor ? gt(lists.id, query.cursor) : undefined)).orderBy(asc(lists.id)).limit(query.limit + 1);
    const result = paginate(rows, query.limit); return c.json({ ...result, data: query.counts === 'false' ? result.data.map(row => ({ ...row, counts: null })) : await readLists(c.env.db, identity, result.data) }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/lists', operationId: 'createContactList', tags: ['Audience'], security, request: { body: json(ListInput) }, responses: { 201: response(List), ...errors } }), async c => {
    const identity = actor(c, 'manage'); const [row] = await c.env.db.insert(lists).values({ id: id('lst'), ...scopeValues(identity), ...c.req.valid('json') }).returning(listColumns); return c.json(row!, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/lists/{id}', operationId: 'getContactList', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(ListRead), ...errors } }), async c => {
    const identity = actor(c), row = await findList(c.env.db, identity, c.req.valid('param').id);
    return c.json((await readLists(c.env.db, identity, [row]))[0]!, 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/lists/{id}', operationId: 'updateContactList', tags: ['Audience'], security, request: { params: IdParams, body: json(ListInput.partial()) }, responses: { 200: response(List), ...errors } }), async c => {
    const identity = actor(c, 'manage'); const [row] = await c.env.db.update(lists).set({ ...c.req.valid('json'), updatedAt: new Date().toISOString() }).where(and(scope(lists, identity), eq(lists.id, c.req.valid('param').id))).returning(listColumns); return c.json(row ?? notFound('List'), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/lists/{id}', operationId: 'deleteContactList', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(Deleted), ...errors } }), async c => {
    const identity = actor(c, 'manage'), listId = c.req.valid('param').id;
    await c.env.db.transaction(async tx => { const [row] = await tx.delete(lists).where(and(scope(lists, identity), eq(lists.id, listId))).returning(); if (!row) notFound('List'); await tx.delete(listMembers).where(and(scope(listMembers, identity), eq(listMembers.listId, listId))); }); return c.json({ id: listId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/lists/{id}/members', operationId: 'listListMembers', tags: ['Audience'], security, description: `Active list members with current list IDs. Pages are also bounded by response size and may return fewer than limit contacts; follow nextCursor while non-null. ${readLimitNote(AUDIENCE_READ_SECONDS)}`, request: { params: IdParams, query: ContactQuery.omit({ listId: true }) }, responses: { 200: response(page(ContactRead)), ...errors } }), async c => {
    const identity = actor(c), listId = c.req.valid('param').id, query = c.req.valid('query');
    return await withAudienceReadMemory(c, async () => {
      const { items, hasMore } = await budgetedRead(c.env.db, async tx => {
        await findList(tx, identity, listId);
        const { rows, hasMore: more } = await boundedContactPage(tx, identity, { ...query, listId });
        return { items: await readContacts(tx, identity, rows, CONTACT_LIST_IDS_PAGE_MAX), hasMore: more };
      }, readLimit(AUDIENCE_READ_SECONDS));
      const { json: body } = buildBoundedPageJson(items, hasMore, AUDIENCE_READ_MAX_BYTES);
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8' } });
    }) as never;
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/lists/{id}/members', operationId: 'addListMembers', tags: ['Audience'], security, request: { params: IdParams, body: json(z.object({ contactIds: z.array(z.string().min(1).max(120)).min(1).max(100) }).strict()) }, responses: { 200: response(z.object({ added: z.number().int() })), ...errors } }), async c => {
    const identity = actor(c, 'manage'), listId = c.req.valid('param').id, contactIds = [...new Set(c.req.valid('json').contactIds)];
    const added = await c.env.db.transaction(async tx => { const [list] = await tx.select().from(lists).where(and(scope(lists, identity), eq(lists.id, listId))).limit(1).for('update'); if (!list) notFound('List'); if ((await lockContacts(tx, identity, contactIds)).length !== contactIds.length) notFound('Contact'); const result = await tx.insert(listMembers).values(contactIds.map(contactId => ({ ...scopeValues(identity), listId, contactId }))).onConflictDoNothing().returning(); return result.length; }); return c.json({ added }, 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/lists/{id}/members/{contactId}', operationId: 'removeListMember', tags: ['Audience'], security, request: { params: IdParams.extend({ contactId: z.string().min(1).max(120) }) }, responses: { 200: response(Deleted), ...errors } }), async c => {
    const identity = actor(c, 'manage'), params = c.req.valid('param'); await findList(c.env.db, identity, params.id);
    await c.env.db.transaction(async tx => { await lockContacts(tx, identity, [params.contactId]); await tx.delete(listMembers).where(and(scope(listMembers, identity), eq(listMembers.listId, params.id), eq(listMembers.contactId, params.contactId))); }); return c.json({ id: params.contactId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/segments', operationId: 'listSegments', tags: ['Audience'], security, request: { query: SearchQuery }, responses: { 200: response(page(Segment)), ...errors } }), async c => {
    const identity = actor(c), query = c.req.valid('query'); const rows = await c.env.db.select().from(segments).where(and(scope(segments, identity), query.search ? searchText(segments.name, query.search) : undefined, query.cursor ? gt(segments.id, query.cursor) : undefined)).orderBy(asc(segments.id)).limit(query.limit + 1); return c.json(paginate(rows, query.limit), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/segments', operationId: 'createSegment', tags: ['Audience'], security, request: { body: json(SegmentInput) }, responses: { 201: response(Segment), ...errors } }), async c => {
    const identity = actor(c, 'manage'); const [row] = await c.env.db.insert(segments).values({ id: id('seg'), ...scopeValues(identity), ...c.req.valid('json') }).returning(); return c.json(row!, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/segments/{id}', operationId: 'getSegment', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(Segment), ...errors } }), async c => c.json(await findSegment(c.env.db, actor(c), c.req.valid('param').id), 200));
  app.openapi(createRoute({ method: 'patch', path: '/v1/segments/{id}', operationId: 'updateSegment', tags: ['Audience'], security, request: { params: IdParams, body: json(SegmentInput.partial()) }, responses: { 200: response(Segment), ...errors } }), async c => {
    const identity = actor(c, 'manage'); const [row] = await c.env.db.update(segments).set({ ...c.req.valid('json'), updatedAt: new Date().toISOString() }).where(and(scope(segments, identity), eq(segments.id, c.req.valid('param').id))).returning(); return c.json(row ?? notFound('Segment'), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/segments/{id}', operationId: 'deleteSegment', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(Deleted), ...errors } }), async c => {
    const identity = actor(c, 'manage'), segmentId = c.req.valid('param').id; const [row] = await c.env.db.delete(segments).where(and(scope(segments, identity), eq(segments.id, segmentId))).returning(); if (!row) notFound('Segment'); return c.json({ id: segmentId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/segments/{id}/preview', operationId: 'previewSegment', tags: ['Audience'], security, description: `Bounded to 1000 matches. Unknown observation history is never classified as inactive. Counts separate suppressed and other non-consenting contacts. ${readLimitNote(PREVIEW_READ_SECONDS)}`, request: { params: IdParams, body: json(z.object({ listId: z.string().min(1).max(120).optional() }).strict()) }, responses: { 200: response(Counts), ...errors } }), async c => {
    const identity = actor(c), segmentId = c.req.valid('param').id, listId = c.req.valid('json').listId;
    return await withAudienceReadMemory(c, async () => {
      const result = await budgetedRead(c.env.db, async tx => {
        const segment = await findSegment(tx, identity, segmentId);
        if (listId) await findList(tx, identity, listId);
        return previewSegmentCounts(tx, identity, segment.rule, listId);
      }, readLimit(PREVIEW_READ_SECONDS));
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8' } });
    }) as never;
  });
  registerAudienceImports(app);
}
