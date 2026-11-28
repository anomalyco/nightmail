import { sql } from 'drizzle-orm';
import { ApiError } from './core/errors.js';
import { digest, id, isoTime, randomSecret } from './core/http.js';
import type { Actor, Ctx, DbExecutor } from './core/types.js';
import { mailboxKeys, type MailboxPermission } from './db/mailbox.js';
import { recordAudit } from './audit.js';
import { agentExpiryRefusal, approvalMadeKey, askedExpiry, createdInboxes, holdKeyAdmin, inactiveKey } from './auth.js';
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
  createdAt: isoTime(row.createdAt)!, lastUsedAt: isoTime(row.lastUsedAt), revokedAt: isoTime(row.revokedAt), agent: null,
});

/**
 * Creates a limited key; the secret is returned once. The caller has already checked that it may administer keys
 * (an unrestricted manage credential, never an agent token). A key an MCP approval creates is tied to it (ownReceiving)
 * and needs its receiving consent. `field` names the request field for errors in the API's access object.
 * `expiresAt`: a time to come, or none; an inbox key ends no later than its inbox.
 */
export async function createLimitedKey(c: Ctx, workspaceId: string, name: string, access: LimitedAccess, field: { addresses: string; inbox: string; mail: string }, asked?: string | null) {
  const mail = [...new Set(access.mail)];
  let mailboxIds: string[] | null, inboxId: string | null = null;
  if (access.type === 'inbox') { mailboxIds = [access.inboxId]; inboxId = access.inboxId; }
  else {
    mailboxIds = access.addressIds ? [...new Set(access.addressIds)] : null;
    if (mailboxIds?.length === 0 && !mail.includes('create')) throw noAddresses(field.addresses);
  }
  const secret = randomSecret(secretPrefixes.addressKey);
  const row = await c.env.db.transaction(async tx => {
    await holdKeyAdmin(tx, c, true);
    let expiresAt: string | null = asked ?? null;
    if (mailboxIds?.length) {
      // Held until commit, so an inbox can't be deleted between this check and the insert (inbox_end locks the row).
      const found = (await tx.execute<{ id: string; kind: string; delete_after: string | null; active: boolean }>(sql`SELECT id, kind, delete_after::text, delete_after IS NULL OR delete_after > now() AS active
        FROM mailboxes WHERE workspace_id = ${workspaceId} AND id = ANY(${sql.param(mailboxIds)}::text[]) FOR SHARE`)).rows;
      if (access.type === 'inbox') {
        if (found[0]?.kind !== 'inbox' || !found[0].active) throw new ApiError(422, 'UNKNOWN_INBOX', 'Choose an active agent inbox in this workspace.', field.inbox);
        // It ends with the inbox (inbox_end), and with an expiring inbox's lease.
        expiresAt = inboxExpiry(asked ?? null, found[0].delete_after, asked != null);
      } else if (found.filter(box => box.active).length !== mailboxIds.length) throw new ApiError(422, 'MAILBOX_NOT_FOUND', 'Every ID must identify an existing receiving address.', field.addresses);
    }
    const [created] = await tx.insert(mailboxKeys).values({ id: id('mbk'), workspaceId, name, hash: await digest(secret), prefix: shownPrefix(secret), mailboxIds, inboxId, permissions: mail, expiresAt }).returning();
    await ownReceiving(tx, c, 'key', created!.id);
    await recordAudit(tx, c, { action: 'api_key.create', workspaceId, target: { type: 'api_key', id: created!.id },
      after: { name, access: limitedAccess(created!), expiresAt: isoTime(created!.expiresAt) ?? undefined, mcpGrant: c.get('actor')?.grantId } });
    return created!;
  });
  c.header('Cache-Control', 'no-store');
  return { row, secret };
}
const noAddresses = (field: string) => new ApiError(422, 'ADDRESS_SCOPE_REQUIRED', 'A key for no addresses needs create: it then reaches only the inboxes it creates. Choose addresses, or every address.', field);
/** An inbox key's end: the expiry set on it, at most its inbox's end, or the inbox's end. `asked`: the caller chose
 *  this expiry now, so one past the inbox's end is refused rather than cut short unseen. */
function inboxExpiry(own: string | null, inboxEnd: string | null, asked: boolean) {
  if (own === null) return inboxEnd;
  if (inboxEnd === null || Date.parse(isoTime(own)!) <= Date.parse(isoTime(inboxEnd)!)) return own;
  if (asked) throw new ApiError(422, 'VALIDATION_FAILED', `This key ends with its inbox at ${isoTime(inboxEnd)}: choose that time or earlier, or null to end with the inbox.`, 'expiresAt');
  return inboxEnd;
}

export type LimitedChange = { name?: string; expiresAt?: string | null; permissions?: unknown; domains?: unknown; addDomains?: unknown; removeDomains?: unknown;
  access?: { type?: 'addresses' | 'inbox'; inboxId?: string; addressIds?: string[] | null; addAddressIds?: string[]; removeAddressIds?: string[]; mail?: MailboxPermission[] } };
/**
 * updateApiKey for a limited key: its name, expiry, addresses or inbox, and mail, in place, under the rules
 * createLimitedKey applies to a new key, so a change never gives a key what a new one couldn't have. It becomes a key
 * for addresses or an inbox key and back on the same secret. The caller isn't this key, and its authority is checked
 * again here (holdKeyAdmin). The change applies at once: every request with the key reads its row (authorizeInboxKey),
 * a long poll reads it again each second (auth.ts longPoll), and dispatch checks the sending address against it
 * (sending/claim.ts), so mail queued from a removed address is not sent. Returns the key's view, with the access it has
 * now: its addresses, and with create the inboxes it created.
 */
export async function updateLimitedKey(tx: DbExecutor, c: Ctx, a: Actor, keyId: string, change: LimitedChange) {
  const workspaceOnly = (['permissions', 'domains', 'addDomains', 'removeDomains'] as const).find(field => change[field] !== undefined);
  if (workspaceOnly) throw new ApiError(422, 'VALIDATION_FAILED', 'A key for addresses or an inbox takes its permissions in access.mail and has no sender domains.', workspaceOnly);
  const access = change.access ?? {}, add = access.addAddressIds ?? [], remove = access.removeAddressIds ?? [];
  const listed = access.addressIds !== undefined || add.length > 0 || remove.length > 0;
  if (access.addressIds !== undefined && (add.length || remove.length)) throw new ApiError(422, 'VALIDATION_FAILED', 'Replace the addresses with addressIds, or add and remove some; not both.', 'access.addressIds');
  if (add.some(id => remove.includes(id))) throw new ApiError(422, 'VALIDATION_FAILED', 'An address can\'t be both added and removed.', 'access.removeAddressIds');
  const asked = askedExpiry(change.expiresAt);
  // An approval (or a key it made) changes a limited key as it creates one: with receiving consent.
  const row = await holdKeyAdmin(tx, c, true, { id: keyId, lock: async () => (await tx.select().from(mailboxKeys).where(sql`${mailboxKeys.workspaceId} = ${a.workspaceId} AND ${mailboxKeys.id} = ${keyId}`).for('update'))[0] });
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'API key was not found.');
  if (row.revokedAt) throw inactiveKey();
  // An inbox key whose inbox ended ended with it. Any other key changes, and an expired one can be given a later expiry.
  const own = row.inboxId ? (await tx.execute<{ end: string | null; active: boolean; follows: boolean }>(sql`SELECT b.delete_after::text AS end, b.delete_after IS NULL OR b.delete_after > now() AS active,
      k.expires_at IS NOT DISTINCT FROM b.delete_after AS follows FROM mailboxes b JOIN mailbox_keys k ON k.workspace_id = b.workspace_id AND k.id = ${row.id}
    WHERE b.workspace_id = ${a.workspaceId} AND b.id = ${row.inboxId} AND b.kind = 'inbox' FOR SHARE OF b`)).rows[0] : undefined;
  if (row.inboxId && !own?.active) throw inactiveKey();
  await approvalMadeKey(tx, a, 'key', row.id);
  const type = access.type ?? (row.inboxId ? 'inbox' : 'addresses'), mail = access.mail ? [...new Set(access.mail)] : row.permissions;
  if (type === 'inbox' && listed) throw new ApiError(422, 'VALIDATION_FAILED', 'An inbox key has one inbox: set access.inboxId to move it, or access.type "addresses" to make it a key for addresses.', 'access.addressIds');
  if (type === 'addresses' && access.inboxId !== undefined) throw new ApiError(422, 'VALIDATION_FAILED', 'access.inboxId is for an inbox key: set access.type "inbox" with it, or addresses with addressIds.', 'access.inboxId');
  let ids: string[] | null = row.mailboxIds, inboxId: string | null = null, inboxEnd: string | null = null;
  if (type === 'inbox') {
    inboxId = access.inboxId ?? row.inboxId;
    if (!inboxId) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose the agent inbox this key belongs to (access.inboxId).', 'access.inboxId');
    if (inboxId === row.inboxId) inboxEnd = own!.end;
    else {
      // Held until commit, as createLimitedKey holds it.
      const [box] = (await tx.execute<{ kind: string; end: string | null; active: boolean }>(sql`SELECT kind, delete_after::text AS end, delete_after IS NULL OR delete_after > now() AS active
        FROM mailboxes WHERE workspace_id = ${a.workspaceId} AND id = ${inboxId} FOR SHARE`)).rows;
      if (box?.kind !== 'inbox' || !box.active) throw new ApiError(422, 'UNKNOWN_INBOX', 'Choose an active agent inbox in this workspace.', 'access.inboxId');
      inboxEnd = box.end;
    }
    ids = [inboxId];
  } else {
    if (access.addressIds !== undefined) ids = access.addressIds && [...new Set(access.addressIds)];
    else if (ids === null && remove.length) throw new ApiError(422, 'ADDRESS_SCOPE_REQUIRED', 'This key covers every address. Set addressIds to the ones it keeps.', 'access.removeAddressIds');
    // A key for every address already has the ones added.
    else if (ids !== null) ids = [...new Set([...ids, ...add])].filter(id => !remove.includes(id));
    if (ids && ids.length > 500) throw new ApiError(422, 'VALIDATION_FAILED', 'A key covers at most 500 addresses. Use a key for every address instead.', access.addressIds ? 'access.addressIds' : 'access.addAddressIds');
    if (ids?.length === 0 && !mail.includes('create')) throw noAddresses(access.addressIds ? 'access.addressIds' : 'access.removeAddressIds');
    // Every address it gains is one of this workspace's that hasn't ended, held until commit like createLimitedKey's. A key
    // for every address gains nothing from addAddressIds, but what it names is checked the same: an ID that is another
    // workspace's or nobody's is refused, not accepted as if the key now covered it.
    const gained = ids === null ? [...new Set(add)] : ids.filter(id => !row.mailboxIds?.includes(id));
    if (gained.length) {
      const found = (await tx.execute<{ id: string }>(sql`SELECT id FROM mailboxes WHERE workspace_id = ${a.workspaceId} AND id = ANY(${sql.param(gained)}::text[])
        AND (delete_after IS NULL OR delete_after > now()) FOR SHARE`)).rows;
      if (found.length !== gained.length) throw new ApiError(422, 'MAILBOX_NOT_FOUND', 'Every ID must identify an existing receiving address.', access.addressIds ? 'access.addressIds' : 'access.addAddressIds');
    }
  }
  // A key with create reaches every inbox it created (authorizeInboxKey), whatever its addresses say. Taking one of those
  // away while create stays would report a removal that didn't happen, so it is refused: the key keeps create for
  // future inboxes, and dropping create in the same request (or deleting the inbox) is what ends its reach. A replacement
  // (addressIds, or a new inbox) names everything the key keeps, so a live inbox it created that it leaves out is taken
  // away too.
  const created = row.permissions.includes('create') || mail.includes('create')
    ? (await tx.execute<{ ids: string[] }>(sql`SELECT ${createdInboxes(sql`${a.workspaceId}`, sql`${row.id}`)} AS ids`)).rows[0]!.ids : [];
  const replaced = type === 'inbox' ? inboxId !== row.inboxId ? ids : undefined : access.addressIds;
  const removed = ids === null ? [] : row.mailboxIds?.filter(id => !ids.includes(id)) ?? [];
  const taken = [...new Set([...removed, ...remove, ...replaced ? created.filter(id => !replaced.includes(id)) : []])];
  if (mail.includes('create') && taken.length) {
    const { rows: kept } = await tx.execute<{ id: string }>(sql`SELECT id FROM mailboxes WHERE workspace_id = ${a.workspaceId} AND created_by = ${row.id}
      AND kind = 'inbox' AND delete_after > now() AND id = ANY(${sql.param(taken)}::text[]) ORDER BY id`);
    if (kept.length) throw new ApiError(409, 'CREATED_INBOX_REACHABLE', `This key created ${kept.map(k => k.id).join(', ')}, and a key with create reaches every inbox it created, so removing it here would leave it reachable. Remove create from access.mail in the same request, or delete the inbox.`,
      remove.length ? 'access.removeAddressIds' : type === 'inbox' ? 'access.inboxId' : 'access.addressIds');
  }
  // Its expiry: as asked, or the one set on it. An inbox key whose expiry is its inbox's end follows its inbox: to the new
  // inbox's end when it moves, and to none when it becomes a key for addresses.
  const set = asked !== undefined ? asked : own?.follows ? null : row.expiresAt;
  const expiresAt = type === 'inbox' ? inboxExpiry(set, inboxEnd, asked != null) : set, expiryChanged = isoTime(expiresAt) !== isoTime(row.expiresAt);
  const reach = (permissions: MailboxPermission[]) => permissions.includes('create') ? created : [];
  const name = change.name ?? row.name;
  if (name === row.name && inboxId === row.inboxId && !expiryChanged && JSON.stringify(ids) === JSON.stringify(row.mailboxIds) && JSON.stringify(mail) === JSON.stringify(row.permissions)) return limitedKeyView(row, reach(mail));
  if (expiryChanged) await agentExpiryRefusal(tx, a, 'key', row.id, isoTime(row.expiresAt), isoTime(expiresAt));
  const [updated] = await tx.update(mailboxKeys).set({ name, mailboxIds: ids, inboxId, permissions: mail, ...expiryChanged ? { expiresAt } : {} }).where(sql`${mailboxKeys.id} = ${row.id}`).returning();
  // Before and after are cut to 20 addresses in the trail; what changed is listed on its own.
  const gained = ids?.filter(id => !row.mailboxIds?.includes(id)) ?? [];
  await recordAudit(tx, c, { action: 'api_key.update', workspaceId: a.workspaceId, target: { type: 'api_key', id: row.id },
    before: { name: row.name, access: limitedAccess(row, reach(row.permissions)), expiresAt: isoTime(row.expiresAt) }, after: { name, access: limitedAccess(updated!, reach(mail)), expiresAt: isoTime(updated!.expiresAt) },
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
