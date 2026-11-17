import { sql } from 'drizzle-orm';
import { ApiError, digest, id, isoTime, randomSecret, type Actor, type Ctx, type DbExecutor } from './core.js';
import { mailboxKeys, type MailboxPermission } from './db/mailbox.js';
import { recordAudit } from './audit.js';
import { approvalMadeKey, createdInboxes, holdKeyAdmin, inactiveKey } from './auth.js';
import { ownReceiving } from './rituals.js';
import { secretPrefixes, shownPrefix } from './brand.js';

// An API key limited to receiving addresses or to one agent inbox. These keep their own table and bearer prefix
// (nm_mbx_…): only mailboxAuth accepts them, so they never reach a workspace route. The public API lists, creates and
// revokes them as API keys (auth.ts), with the access below in place of workspace permissions.
export type LimitedAccess =
  | { type: 'addresses'; addressIds?: string[] | null; mail: MailboxPermission[] }
  | { type: 'inbox'; inboxId: string; mail: MailboxPermission[] };
type Row = typeof mailboxKeys.$inferSelect;

/** What a limited key may do, as the API shows it. A key on exactly one agent inbox belongs to it (inbox_id). With create
 *  it also reaches the inboxes it created (auth.ts createdInboxes): createdInboxIds, given where they were read. */
export const limitedAccess = <C extends string[] | undefined = undefined>(row: Pick<Row, 'inboxId' | 'mailboxIds' | 'permissions'>, createdInboxIds?: C) => ({
  type: row.inboxId ? 'inbox' as const : 'addresses' as const, addressIds: row.mailboxIds, inboxId: row.inboxId ?? null, mail: row.permissions, createdInboxIds: createdInboxIds as C,
});
/** The API's view of a limited key. A new key has created nothing yet. */
export const limitedKeyView = (row: Row, createdInboxIds: string[] = []) => ({
  id: row.id, name: row.name, prefix: row.prefix, permissions: [] as ('read' | 'send' | 'manage')[], domains: [] as string[],
  access: limitedAccess(row, createdInboxIds), expiresAt: isoTime(row.expiresAt),
  createdAt: isoTime(row.createdAt)!, lastUsedAt: isoTime(row.lastUsedAt), revokedAt: isoTime(row.revokedAt),
});

/**
 * Creates a limited key; the secret is returned once. The caller has already checked that it may administer keys
 * (an unrestricted manage credential, never an agent token). A key an MCP approval creates is tied to it (ownReceiving)
 * and needs its receiving consent. `field` names the request field for errors: the API's access object, or the
 * deprecated createInboundKey's top-level fields.
 */
export async function createLimitedKey(c: Ctx, workspaceId: string, name: string, access: LimitedAccess, field: { addresses: string; inbox: string; mail: string }) {
  const mail = [...new Set(access.mail)];
  let mailboxIds: string[] | null, inboxId: string | null = null;
  if (access.type === 'inbox') {
    if (mail.includes('create')) throw new ApiError(422, 'VALIDATION_FAILED', 'A key for one inbox can read, send and modify; create needs a key for addresses.', field.mail);
    mailboxIds = [access.inboxId]; inboxId = access.inboxId;
  } else {
    mailboxIds = access.addressIds ? [...new Set(access.addressIds)] : null;
    if (mail.includes('create') && mailboxIds === null || mailboxIds?.length === 0 && !mail.includes('create'))
      throw new ApiError(422, 'ADDRESS_SCOPE_REQUIRED', 'Provisioning keys need an explicit addressIds scope.', field.addresses);
  }
  const secret = randomSecret(secretPrefixes.addressKey);
  const row = await c.env.db.transaction(async tx => {
    await holdKeyAdmin(tx, c, true);
    let expiresAt: string | null = null;
    if (mailboxIds?.length) {
      // Held until commit, so an inbox can't be deleted between this check and the insert (inbox_end locks the row).
      const found = (await tx.execute<{ id: string; kind: string; delete_after: string | null; active: boolean }>(sql`SELECT id, kind, delete_after::text, delete_after IS NULL OR delete_after > now() AS active
        FROM mailboxes WHERE workspace_id = ${workspaceId} AND id = ANY(${sql.param(mailboxIds)}::text[]) FOR SHARE`)).rows;
      if (access.type === 'inbox') {
        if (found[0]?.kind !== 'inbox' || !found[0].active) throw new ApiError(422, 'UNKNOWN_INBOX', 'Choose an active agent inbox in this workspace.', field.inbox);
        // It ends with the inbox (inbox_end), and with an expiring inbox's lease.
        expiresAt = found[0].delete_after;
      } else if (found.length !== mailboxIds.length) throw new ApiError(422, 'MAILBOX_NOT_FOUND', 'Every ID must identify an existing receiving address.', field.addresses);
    }
    const [created] = await tx.insert(mailboxKeys).values({ id: id('mbk'), workspaceId, name, hash: await digest(secret), prefix: shownPrefix(secret), mailboxIds, inboxId, permissions: mail, expiresAt }).returning();
    await ownReceiving(tx, c, 'key', created!.id);
    await recordAudit(tx, c, { action: 'api_key.create', workspaceId, target: { type: 'api_key', id: created!.id },
      after: { name, access: limitedAccess(created!), mcpGrant: c.get('actor')?.grantId } });
    return created!;
  });
  c.header('Cache-Control', 'no-store');
  return { row, secret };
}

export type LimitedChange = { name?: string; access?: { addressIds?: string[] | null; addAddressIds?: string[]; removeAddressIds?: string[]; mail?: MailboxPermission[] }; permissions?: unknown; domains?: unknown };
/**
 * updateApiKey for a limited key: its name, its addresses and its mail, in place, under the rules createLimitedKey
 * applies to a new key, so a change never gives a key what a new one couldn't have. The caller isn't this key, and its
 * authority is checked again here (holdKeyAdmin). The change applies at once: every request with the key reads its row
 * (authorizeInboxKey), a long poll reads it again each second (auth.ts longPoll), and dispatch checks the sending
 * address against it (dispatcher.ts), so mail queued from a removed address is not sent. Returns the key's view, with
 * the access it has now: its addresses, and with create the inboxes it created.
 */
export async function updateLimitedKey(tx: DbExecutor, c: Ctx, a: Actor, keyId: string, change: LimitedChange) {
  if (change.permissions || change.domains) throw new ApiError(422, 'VALIDATION_FAILED', 'A key for addresses or an inbox takes its permissions in access.mail and has no sender domains.', change.permissions ? 'permissions' : 'domains');
  const access = change.access ?? {}, add = access.addAddressIds ?? [], remove = access.removeAddressIds ?? [];
  if (access.addressIds !== undefined && (add.length || remove.length)) throw new ApiError(422, 'VALIDATION_FAILED', 'Replace the addresses with addressIds, or add and remove some; not both.', 'access.addressIds');
  if (add.some(id => remove.includes(id))) throw new ApiError(422, 'VALIDATION_FAILED', 'An address can\'t be both added and removed.', 'access.removeAddressIds');
  // An approval (or a key it made) changes a limited key as it creates one: with receiving consent.
  const row = await holdKeyAdmin(tx, c, true, { id: keyId, lock: async () => (await tx.select().from(mailboxKeys).where(sql`${mailboxKeys.workspaceId} = ${a.workspaceId} AND ${mailboxKeys.id} = ${keyId}`).for('update'))[0] });
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'API key was not found.');
  if (row.revokedAt || row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) throw inactiveKey();
  await approvalMadeKey(tx, a, 'key', row.id);
  const inbox = row.inboxId !== null, mail = access.mail ? [...new Set(access.mail)] : row.permissions;
  if (inbox && (access.addressIds !== undefined || add.length || remove.length)) throw new ApiError(422, 'VALIDATION_FAILED', 'A key for one inbox keeps its inbox. Change its mail, or create a key for addresses.', 'access.addressIds');
  if (inbox && mail.includes('create')) throw new ApiError(422, 'VALIDATION_FAILED', 'A key for one inbox can read, send and modify; create needs a key for addresses.', 'access.mail');
  let ids = row.mailboxIds;
  if (access.addressIds !== undefined) ids = access.addressIds && [...new Set(access.addressIds)];
  else if (ids === null && remove.length) throw new ApiError(422, 'ADDRESS_SCOPE_REQUIRED', 'This key covers every address. Set addressIds to the ones it keeps.', 'access.removeAddressIds');
  // A key for every address already has the ones added.
  else if (ids !== null) ids = [...new Set([...ids, ...add])].filter(id => !remove.includes(id));
  if (ids && ids.length > 500) throw new ApiError(422, 'VALIDATION_FAILED', 'A key covers at most 500 addresses. Use a key for every address instead.', access.addressIds ? 'access.addressIds' : 'access.addAddressIds');
  if (!inbox && (mail.includes('create') && ids === null || ids?.length === 0 && !mail.includes('create')))
    throw new ApiError(422, 'ADDRESS_SCOPE_REQUIRED', 'Provisioning keys need an explicit addressIds scope.', 'access.addressIds');
  // Every address it gains is one of this workspace's, held until commit like createLimitedKey's.
  const gained = ids?.filter(id => !row.mailboxIds?.includes(id)) ?? [];
  if (gained.length) {
    const found = (await tx.execute<{ id: string }>(sql`SELECT id FROM mailboxes WHERE workspace_id = ${a.workspaceId} AND id = ANY(${sql.param(gained)}::text[]) FOR SHARE`)).rows;
    if (found.length !== gained.length) throw new ApiError(422, 'MAILBOX_NOT_FOUND', 'Every ID must identify an existing receiving address.', access.addressIds ? 'access.addressIds' : 'access.addAddressIds');
  }
  // A key with create reaches every inbox it created (authorizeInboxKey), whatever its addresses say. Taking one of those
  // away while create stays would report a removal that didn't happen, so it is refused: the key keeps create for
  // future inboxes, and dropping create in the same request (or deleting the inbox) is what ends its reach. A replacement
  // names everything the key keeps, so a live inbox it created that the new list leaves out is taken away too.
  const created = row.permissions.includes('create') || mail.includes('create')
    ? (await tx.execute<{ ids: string[] }>(sql`SELECT ${createdInboxes(sql`${a.workspaceId}`, sql`${row.id}`)} AS ids`)).rows[0]!.ids : [];
  const removed = ids === null ? [] : row.mailboxIds?.filter(id => !ids.includes(id)) ?? [];
  const taken = [...new Set([...removed, ...remove, ...access.addressIds ? created.filter(id => !access.addressIds!.includes(id)) : []])];
  if (mail.includes('create') && taken.length) {
    const { rows: kept } = await tx.execute<{ id: string }>(sql`SELECT id FROM mailboxes WHERE workspace_id = ${a.workspaceId} AND created_by = ${row.id}
      AND kind = 'inbox' AND delete_after > now() AND id = ANY(${sql.param(taken)}::text[]) ORDER BY id`);
    if (kept.length) throw new ApiError(409, 'CREATED_INBOX_REACHABLE', `This key created ${kept.map(k => k.id).join(', ')}, and a key with create reaches every inbox it created, so removing it here would leave it reachable. Remove create from access.mail in the same request, or delete the inbox.`,
      remove.length ? 'access.removeAddressIds' : 'access.addressIds');
  }
  const reach = (permissions: MailboxPermission[]) => permissions.includes('create') ? created : [];
  const name = change.name ?? row.name;
  if (name === row.name && JSON.stringify(ids) === JSON.stringify(row.mailboxIds) && JSON.stringify(mail) === JSON.stringify(row.permissions)) return limitedKeyView(row, reach(mail));
  const [updated] = await tx.update(mailboxKeys).set({ name, mailboxIds: ids, permissions: mail }).where(sql`${mailboxKeys.id} = ${row.id}`).returning();
  // Before and after are cut to 20 addresses in the trail; what changed is listed on its own.
  await recordAudit(tx, c, { action: 'api_key.update', workspaceId: a.workspaceId, target: { type: 'api_key', id: row.id },
    before: { name: row.name, access: limitedAccess(row, reach(row.permissions)) }, after: { name, access: limitedAccess(updated!, reach(mail)) },
    details: { ...gained.length && row.mailboxIds ? { addedAddressIds: gained } : {}, ...removed.length ? { removedAddressIds: removed } : {} } });
  return limitedKeyView(updated!, reach(mail));
}

/** Revokes a limited key. A repeated revoke keeps the first time and writes no second audit row. */
export async function revokeLimitedKey(c: Ctx, workspaceId: string, keyId: string) {
  return await c.env.db.transaction(async tx => {
    const [row] = await tx.select().from(mailboxKeys).where(sql`${mailboxKeys.workspaceId} = ${workspaceId} AND ${mailboxKeys.id} = ${keyId}`).for('update');
    if (!row) return null;
    if (row.revokedAt) return { row, fresh: false };
    const [revoked] = await tx.update(mailboxKeys).set({ revokedAt: new Date().toISOString() }).where(sql`${mailboxKeys.id} = ${row.id}`).returning();
    await recordAudit(tx, c, { action: 'api_key.revoke', workspaceId, target: { type: 'api_key', id: row.id }, before: { name: row.name, access: limitedAccess(row) } });
    return { row: revoked!, fresh: true };
  });
}
