import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { auditContext, auditInsert, recordAudit, type AuditContext } from './audit.js';
import { ApiError, dashboardSession, denied, digest, errors, id, IdParams, json, logError, memberAdminRefusal, ModuleLoadError, notFound, response, wrapModuleLoad, type App, type Ctx, type DbExecutor } from './core.js';
import type { WorkspaceFocus } from './workspace-focus.js';
import { INVITATION_EMAILS, inviteByEmail } from './account-notices.js';
import { baneUsers } from './db/users.js';
import { workspaceMembers, workspaces } from './db/workspaces.js';
import { invitationRecipient, verifiedDashboardUser } from './dashboard-auth.js';
import { accountSessionPolicy } from './account-login.js';
import { operatorRoleOf, type OperatorRole } from './operator-identity.js';
import { productName } from './brand.js';
import { shownName } from './notices.js';
import type { Config } from './core.js';

export const WorkspaceRole = z.enum(['owner', 'admin', 'member']);
type Role = z.infer<typeof WorkspaceRole>;
export const Workspace = z.object({ id: z.string(), name: z.string(), slug: z.string(), role: WorkspaceRole }).openapi('Workspace');
const Member = z.object({ id: z.string(), userId: z.string(), email: z.string(), name: z.string(), role: WorkspaceRole }).openapi('WorkspaceMember');
const Invitation = z.object({ id: z.string(), workspaceId: z.string(), email: z.string(), role: WorkspaceRole, expiresAt: z.string(), acceptUrl: z.string().url() }).openapi('WorkspaceInvitation');
const CreatedInvitation = Invitation.extend({ emailed: z.boolean().describe('Whether the invitation was emailed to the invitee, with acceptUrl. When false, share acceptUrl yourself; notEmailedReason says why.'),
  notEmailedReason: z.enum(['not_available', 'paused', 'new_workspace', 'allowance_used']).nullable().describe('Why no email went out, null when one did. not_available: this installation sends no invitation email, or your account has no verified address to be named by. paused: this workspace is paused. new_workspace: invitations are emailed once the workspace has its own verified domain or has finished its evaluation. allowance_used: the invitation emails for today, or to this address, are used.'),
  nextStep: z.string().describe('What to do next, for people and agents: whether the invitee was emailed, or acceptUrl is yours to share.') }).openapi('CreatedWorkspaceInvitation');
const InvitationPreview = z.object({ id: z.string(), workspaceId: z.string(), workspaceName: z.string().describe('The workspace’s name as plain words, at most 40 characters; empty when nothing of it can be shown.'), workspaceSlug: z.string(), inviterName: z.string().describe('The inviter’s display name as plain words, like workspaceName; may be empty. Identify the inviter by inviterEmail.'), inviterEmail: z.string().describe('The inviter’s verified address; empty when they have none.'), role: WorkspaceRole, expiresAt: z.string(), status: z.enum(['pending', 'accepted']) }).openapi('WorkspaceInvitationPreview');
const Invite = z.object({ email: z.email().toLowerCase(), role: WorkspaceRole }).strict().openapi('InviteWorkspaceMember');
const Removed = z.object({ id: z.string(), deleted: z.literal(true) });
// Members and invitations also take an owner's or admin's own MCP sign-in (memberAdminRefusal), which reaches REST
// only through /mcp; no bearer credential is accepted here, so the catalog lists them by memberAdminRoute.
const security: Record<string, string[]>[] = [{ dashboardSession: [] }, { secureDashboardSession: [] }];
const tags = ['Workspaces'];
const base = '/v1/workspaces/current';

/** Inviter membership join and claimability predicates shared by claimInvitation, pendingInvitation and getWorkspaceInvitation. */
const invitationInviterJoin = sql`JOIN workspace_members inviter ON inviter.workspace_id = i.workspace_id AND inviter.user_id = i.inviter_id`;
const claimablePendingSql = sql`i.status = 'pending' AND i.expires_at > now() AND (inviter.role = 'owner' OR (inviter.role = 'admin' AND i.role <> 'owner'))`;
const claimableInvitationWhere = (invitationId: string, email: string, acceptedForUserId?: string) => sql`i.id = ${invitationId} AND i.email = ${email.toLowerCase()} AND i.role IN ('owner','admin','member') AND (${acceptedForUserId === undefined
  ? claimablePendingSql
  : sql`(${claimablePendingSql}) OR (i.status = 'accepted' AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id = i.workspace_id AND m.user_id = ${acceptedForUserId}))`})`;

// Accept only the invitation the verified recipient followed. Never overwrite an existing role.
// The joining user is the actor (not yet a member of the workspace they join); the request supplies the rest.
export async function claimInvitation(db: DbExecutor, userId: string, email: string, invitationId: string, request: Omit<AuditContext, 'actor'> = { requestId: null, ipNetwork: null, userAgent: null }) {
  const audit = auditInsert({ ...request, actor: { type: 'member', id: userId, userId, via: 'dashboard' } },
    { action: 'member.join', workspaceId: sql`joined.workspace_id`, target: { type: 'member', id: sql`joined.id` }, after: sql`jsonb_build_object('role', joined.role)`, details: { invitationId } }, { from: sql`joined` });
  const result = await db.execute<{ workspace_id: string }>(sql`WITH pending AS (
    SELECT i.id FROM workspace_invitations i ${invitationInviterJoin}
    JOIN nightmail_users recipient ON recipient.id=${userId} AND recipient.email_verified AND lower(recipient.email)=i.email
    WHERE ${claimableInvitationWhere(invitationId, email)} FOR UPDATE OF i FOR SHARE OF inviter,recipient
  ), claimed AS (
    UPDATE workspace_invitations i SET status = 'accepted' FROM pending WHERE i.id = pending.id RETURNING i.workspace_id, i.role
  ), joined AS (
    INSERT INTO workspace_members (id, workspace_id, user_id, role) SELECT ${id('mem')}, workspace_id, ${userId}, role FROM claimed
    ON CONFLICT (workspace_id, user_id) DO NOTHING RETURNING id, workspace_id, role
  ), audit AS (${audit}) UPDATE nightmail_users u SET selected_workspace_id = claimed.workspace_id FROM claimed WHERE u.id = ${userId} RETURNING claimed.workspace_id`);
  return result.rows[0]?.workspace_id;
}

// The invitation the verified recipient followed is still claimable (the same conditions as
// claimInvitation). Reading it changes nothing.
export async function pendingInvitation(db: DbExecutor, email: string, invitationId: string) {
  const result = await db.execute(sql`SELECT FROM workspace_invitations i ${invitationInviterJoin}
    WHERE ${claimableInvitationWhere(invitationId, email)}`);
  return !!result.rowCount;
}

// Called only in the transaction that *inserts* the OIDC user. Ordinary dashboard requests,
// refreshes and dispatch cannot bootstrap a removed member or create a second organization.
// Nobody joins during sign-in (M9). An account whose only way in is the invitation it followed is
// created with no membership; its session can only review and accept that invitation.
// Returns the new workspace's ID, true for an account that joins by its invitation instead, or false.
export async function onboardNewUser(db: DbExecutor, user: { id: string; name: string; email: string | null }, allowSignup: boolean, region: string, invitationId: string | null, config?: BuiltinConfig): Promise<string | boolean> {
  if (!allowSignup) return !!invitationId && !!user.email && await pendingInvitation(db, user.email, invitationId);
  const row = await insertOwnedWorkspace(db, user.id, `${ownerName(user.name, user.email).slice(0, 105)}'s workspace`, region, undefined, undefined, config);
  return row?.id ?? true;
}
/** Whose workspace it is, for its first name: the person's name, or their address's local part without a +tag when the
 * name is only an address or its local part ("ryan+test@acme.com" names "ryan's workspace"). */
export function ownerName(name: string, email: string | null) {
  const given = name.trim(), local = email?.split('@')[0] ?? '';
  const address = !given || given.includes('@') || given.toLowerCase() === local.toLowerCase();
  if (!address) return given;
  return (given ? given.split('@')[0]! : local).replace(/\+.*$/, '') || productName;
}

// One statement: the workspace, its regional settings and the owner membership. With `ownedBelow`,
// nothing is inserted once the user already owns that many workspaces (the caller holds the user lock)
// or is no longer a member of `memberOf`, the workspace the request authenticated through.
type BuiltinConfig = Pick<Config, 'multiTenant' | 'builtinDomain'>;
// The built-in domain's label is given in the same transaction (builtin-domain.ts); the domain itself follows the workspace's
// Hosted connection (provider-connections.ts).
async function insertOwnedWorkspace(db: DbExecutor, userId: string, name: string, region: string, limit?: { ownedBelow: number; memberOf: string }, audit?: AuditContext, config?: BuiltinConfig) {
  const workspaceId = id('ws');
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0,30).replace(/^-|-$/g, '') || 'workspace'}-${workspaceId.slice(3)}`;
  const result = await db.execute<{ id: string; name: string; slug: string }>(sql`WITH created AS (
    INSERT INTO workspaces(id, name, slug, quota_sponsor) SELECT ${workspaceId}, ${name}, ${slug}, ${userId}
    ${limit === undefined ? sql`` : sql`WHERE (SELECT count(*) FROM workspace_members WHERE user_id = ${userId} AND role = 'owner') < ${limit.ownedBelow}
      AND EXISTS(SELECT 1 FROM workspace_members WHERE user_id = ${userId} AND workspace_id = ${limit.memberOf})`}
    RETURNING id, name, slug
  ), region_settings AS (
    INSERT INTO ses_installation_settings(workspace_id, installation_id, default_region, enabled_regions)
    SELECT id, ${id('install')}, ${region}, ${JSON.stringify([region])}::jsonb FROM created
  ), owner AS (
    INSERT INTO workspace_members(id, workspace_id, user_id, role) SELECT ${id('mem')}, id, ${userId}, 'owner' FROM created
  )${audit ? sql`, audit AS (${auditInsert(audit, { action: 'workspace.create', workspaceId: sql`created.id`, target: { type: 'workspace', id: sql`created.id` }, after: { name, region } }, { from: sql`created` })})` : sql``}
  SELECT id, name, slug FROM created`);
  const row = result.rows[0];
  if (row && config?.multiTenant && config.builtinDomain) await (await wrapModuleLoad(() => import('./builtin-domain.js'))).allocateBuiltinDomain(db, config, row.id, row.name);
  return row;
}
const maxOwnedWorkspaces = 10;

export type SessionMembershipRow = { workspaces: { id: string; name: string; slug: string; role: string }[]; operator: OperatorRole | null; focus: WorkspaceFocus[] | null; ageSeconds: number | null; byo: boolean };
/** One row even with no memberships: the person's roles and the selected workspace's onboarding flags. */
export const sessionMembershipsQuery = (userId: string, current: string) => sql`SELECT ${operatorRoleOf(userId)} AS operator,
  coalesce((SELECT json_agg(json_build_object('id',w.id,'name',w.name,'slug',w.slug,'role',m.role) ORDER BY w.name,w.id) FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=${userId}),'[]') AS workspaces,
  cw.focus, extract(epoch FROM now()-cw.created_at)::float8 AS "ageSeconds", coalesce(cw.byo_v2_enabled,false) AS byo
  FROM (SELECT 1) one LEFT JOIN workspaces cw ON cw.id=${current}`;

// Serialize governance writes per workspace. Read the caller and owner count *after* locking:
// concurrent demotions cannot authorize each other on an old snapshot or remove both owners.
function administer<T>(c: Ctx, action: (db: DbExecutor, workspaceId: string, userId: string, role: 'owner' | 'admin') => Promise<T>, { workspaceId, userId, signIn = false }: { workspaceId: string; userId: string; signIn?: boolean } = dashboardSession(c, true)) {
  return c.env.db.transaction(async db => {
    await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for('no key update');
    const [member] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    if (member?.role !== 'owner' && member?.role !== 'admin') throw denied('PERMISSION_DENIED', 'Workspace administration requires an owner or admin.', { person: 'admin' });
    // An owner's or admin's own MCP sign-in (every such write needs manage): the approval as it is now, read after the
    // workspace lock (the order a member's removal takes the two in) and held, shared, until commit. One revoked,
    // expired, narrowed or no longer this person's while the request waited refuses the write.
    if (signIn) {
      const grant = await (await wrapModuleLoad(() => import('./mcp-auth.js'))).getMcpGrantActor(c.env, c.get('actor').keyId, workspaceId, db);
      if (grant?.userId !== userId || !grant.permissions.includes('manage')) throw new ApiError(401, 'AUTH_INVALID', 'The MCP approval behind this request was revoked or changed while it ran. Nothing was changed.');
    }
    return action(db, workspaceId, userId, member.role);
  });
}
const ownerRequired = () => denied('OWNER_REQUIRED', 'Only an owner can change workspace ownership.', { person: 'owner' });
function changeMember(c: Ctx, memberId: string, newRole?: Role) {
  return administer(c, async (db, wid, _uid, role) => {
    const filter = and(eq(workspaceMembers.workspaceId, wid), eq(workspaceMembers.id, memberId));
    const [member] = await db.select({ role: workspaceMembers.role, userId: workspaceMembers.userId, otherOwner: sql<boolean>`EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id = ${wid} AND role = 'owner' AND id <> ${memberId})` }).from(workspaceMembers).where(filter);
    if (!member) return notFound('Member');
    if ((member.role === 'owner' || newRole === 'owner') && role !== 'owner') throw ownerRequired();
    if (member.role === 'owner' && newRole !== 'owner' && !member.otherOwner) throw new ApiError(409, 'LAST_OWNER', 'Promote another owner before removing or demoting the last owner.');
    if (newRole) await db.update(workspaceMembers).set({ role: newRole }).where(filter);
    else await db.delete(workspaceMembers).where(filter);
    if (newRole !== member.role) await recordAudit(db, c, { action: newRole ? 'member.role_change' : 'member.remove', workspaceId: wid, userId: member.userId, target: { type: 'member', id: memberId },
      before: { role: member.role }, ...(newRole ? { after: { role: newRole } } : {}) });
  });
}
/** Members and invitations: an owner or admin in person, in the dashboard or over their own MCP sign-in (core.ts). */
function memberAdmin(c: Ctx, change: boolean) {
  if (!c.env.config.multiTenant) return notFound('Endpoint');
  const a = c.get('actor'), refusal = memberAdminRefusal(a, change);
  if (refusal) throw refusal;
  return { workspaceId: a.workspaceId, userId: a.credential === 'dashboard' ? a.keyId.slice(5) : a.userId!, signIn: a.credential === 'mcp' };
}
type InviteRow = { id: string; workspaceId: string; email: string; role: Role; expiresAt: Date };
const dashboardUrl = (c: Ctx, path: string) => `${c.env.config.publicUrl.replace(/\/$/, '')}${path}`;
function invitationView(c: Ctx, row: InviteRow) {
  return { ...row, expiresAt: new Date(row.expiresAt).toISOString(), acceptUrl: dashboardUrl(c, `/overview?invitation=${encodeURIComponent(row.id)}`) };
}
async function invite(c: Ctx, input: z.infer<typeof Invite>) {
  const caller = memberAdmin(c, true);
  // An agent never makes an owner, even for an owner: ownership is given in the dashboard. Below that, administer
  // keeps every invitation at or under the caller's own role, checked again when the invitee accepts.
  if (input.role === 'owner' && caller.signIn) throw denied('DASHBOARD_AUTH_REQUIRED', `Owner invitations are made in the dashboard: ${dashboardUrl(c, '/settings#members')}. Over MCP, invite an admin or a member.`, { person: 'owner', credential: 'dashboard' });
  return administer(c, async (db, wid, uid, role) => {
    if (input.role === 'owner' && role !== 'owner') throw ownerRequired();
    const result = await db.execute<InviteRow>(sql`WITH invited AS (INSERT INTO workspace_invitations(id, workspace_id, email, role, inviter_id, expires_at)
      SELECT ${id('inv')}, ${wid}, ${input.email}, ${input.role}, ${uid}, now() + interval '7 days'
      WHERE NOT EXISTS(SELECT 1 FROM workspace_members m JOIN nightmail_users u ON u.id = m.user_id WHERE m.workspace_id = ${wid} AND u.email_verified AND lower(u.email) = ${input.email})
      ON CONFLICT (workspace_id, email) WHERE status = 'pending' DO UPDATE SET id = excluded.id, role = excluded.role, inviter_id = excluded.inviter_id, expires_at = excluded.expires_at, created_at = now()
      WHERE workspace_invitations.expires_at <= now()
      RETURNING id, workspace_id AS "workspaceId", email, role, expires_at AS "expiresAt"
    ), audit AS (${auditInsert(auditContext(c), { action: 'member.invite', workspaceId: wid, userId: null, target: { type: 'invitation', id: sql`invited.id` }, after: { email: input.email, role: input.role } }, { from: sql`invited` })})
    SELECT * FROM invited`);
    if (!result.rows[0]) throw new ApiError(409, 'ALREADY_INVITED_OR_MEMBER', 'This address already has a pending invitation or membership.');
    const view = invitationView(c, result.rows[0]);
    // Its email is queued with it. Without one the inviter shares the link, and is told why there is none.
    const notEmailedReason = await inviteByEmail(c.env, db, result.rows[0], uid, await digest(view.email)), emailed = !notEmailedReason;
    if (emailed) { const a = c.get('actor'); a.wakeJobs = Math.max(a.wakeJobs ?? 0, 1); }
    const joins = `they join as ${view.role} after signing in with that verified address, before ${view.expiresAt}`;
    const why = notEmailedReason === 'new_workspace' ? `No email was sent: ${productName} emails invitations once this workspace has its own verified domain or has finished its evaluation.`
      : notEmailedReason === 'allowance_used' ? 'No email was sent: the invitation emails for today, or to this address, are used.' : 'No email was sent.';
    return { ...view, emailed, notEmailedReason, nextStep: emailed ? `${view.email} was emailed the invitation: ${joins}. acceptUrl is the same link, if you want to share it yourself.` : `${why} Share acceptUrl with ${view.email} yourself: ${joins}.` };
  }, caller);
}

export function registerWorkspaces(app: App) {
  app.openapi(createRoute({ method: 'post', path: '/v1/workspaces', operationId: 'createWorkspace', tags, security,
    description: `Create another workspace you own. Hosted: staff only for now (decided at sign-in; everyone else gets 403 WORKSPACE_LIMIT, and GET /v1/me says so in canCreateWorkspace), up to ${maxOwnedWorkspaces} per account. Select it with X-Nightmail-Workspace.`,
    request: { body: json(z.object({ name: z.string().trim().min(1).max(120) }).strict()) }, responses: { 201: response(Workspace), ...errors } }), async c => {
    const a = dashboardSession(c), { name } = c.req.valid('json'), policy = await accountSessionPolicy(c.env, c.req.raw.headers);
    const created = await c.env.db.transaction(async db => {
      // Lock the user so concurrent creates count each other's workspaces.
      const [user] = await db.select({id:baneUsers.id}).from(baneUsers).where(eq(baneUsers.id,a.userId)).for('update');
      // Decided by the sign-in, never by an address: hosted staff (the provider identity), or a self-hosted allowed subject.
      // Hosted, everyone else is an approved account limited to the workspace it signed up with, not an unapproved one.
      if (c.env.config.multiTenant ? !user || policy?.staff !== true : !user || !policy || !c.env.config.allowedSubjects.includes(policy.subject))
        throw c.env.config.multiTenant ? new ApiError(403, 'WORKSPACE_LIMIT', 'Your account can have one workspace for now.') : new ApiError(403, 'SIGNUP_NOT_APPROVED', 'This account is not approved to create workspaces.');
      const row = await insertOwnedWorkspace(db, a.userId, name, c.env.config.regions[0]!, { ownedBelow: maxOwnedWorkspaces, memberOf: a.workspaceId }, auditContext(c), c.env.config);
      if (row) return row;
      const [member] = await db.select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(eq(workspaceMembers.userId, a.userId), eq(workspaceMembers.workspaceId, a.workspaceId)));
      if (!member) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in with your OIDC account.');
      throw new ApiError(409, 'WORKSPACE_LIMIT', `You already own ${maxOwnedWorkspaces} workspaces, the most one account can have.`);
    });
    // With a built-in domain, its Hosted mail starts right after this answers, as a sign-up's does (startHostedMailAfter);
    // onboarding starts it if it couldn't.
    if (c.env.config.multiTenant && c.env.config.builtinDomain) void (await wrapModuleLoad(() => import('./provider-connections.js'))).startHostedMailAfter(c.env, created.id, auditContext(c));
    return c.json(Workspace.parse({ ...created, role: 'owner' }), 201);
  });
  app.openapi(createRoute({ method: 'patch', path: base, operationId: 'renameCurrentWorkspace', tags, security, request: { body: json(z.object({ name: z.string().trim().min(1).max(120) }).strict()) }, responses: { 200: response(Workspace), ...errors } }), async c => {
    const { name } = c.req.valid('json');
    const row = await administer(c, async (db, wid, _uid, role) => {
      const { rows: [w] } = await db.execute<{ id: string; name: string; slug: string }>(sql`WITH old AS (SELECT name FROM workspaces WHERE id = ${wid}),
        renamed AS (UPDATE workspaces SET name = ${name} WHERE id = ${wid} RETURNING id, name, slug),
        audit AS (${auditInsert(auditContext(c), { action: 'workspace.rename', workspaceId: wid, target: { type: 'workspace', id: wid }, before: sql`jsonb_build_object('name', (SELECT name FROM old))`, after: { name } }, { from: sql`renamed` })})
        SELECT id, name, slug FROM renamed`);
      return { ...w!, role };
    });
    return c.json(row, 200);
  });
  const inPerson = 'Owners and admins, in the dashboard or over their own MCP sign-in; API keys and agent tokens get 403 DASHBOARD_AUTH_REQUIRED.';
  app.openapi(createRoute({ method: 'get', path: `${base}/members`, operationId: 'listWorkspaceMembers', tags, security, description: `List the workspace's members and their roles. ${inPerson}`, responses: { 200: response(z.object({ data: z.array(Member) })), ...errors } }), async c => {
    const a = memberAdmin(c, false);
    const rows = await c.env.db.select({ id: workspaceMembers.id, userId: workspaceMembers.userId, role: workspaceMembers.role, email: sql<string>`coalesce(${baneUsers.email}, '')`, name: baneUsers.name }).from(workspaceMembers).innerJoin(baneUsers, eq(baneUsers.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, a.workspaceId)).orderBy(baneUsers.email,workspaceMembers.id);
    return c.json({ data: rows.map(row => Member.parse(row)) }, 200);
  });
  // inviteWorkspaceMember is the dashboard's older name for createWorkspaceInvitation; agents use the latter.
  for (const [resource, operationId] of [['members', 'inviteWorkspaceMember'], ['invitations', 'createWorkspaceInvitation']] as const) {
    app.openapi(createRoute({ method: 'post', path: `${base}/${resource}` as const, operationId, description: `Invite an email address. Membership starts only after acceptance by the verified address. Hosted, the invitee is emailed the link once the workspace has its own verified domain or has finished its evaluation (emailed says so; at most ${INVITATION_EMAILS.workspaceDay} invitation emails a workspace a day); otherwise share the returned URL. An invitation never grants more than the inviter's role, and an owner invitation is made only in the dashboard.${resource === 'invitations' ? ` ${inPerson}` : ''}`, tags, security, request: { body: json(Invite) }, responses: { 201: response(CreatedInvitation), ...errors } }), async c => c.json(await invite(c, c.req.valid('json')), 201));
  }
  app.openapi(createRoute({ method: 'patch', path: `${base}/members/{id}`, operationId: 'updateWorkspaceMember', tags, security, request: { params: IdParams, body: json(z.object({ role: WorkspaceRole }).strict()) }, responses: { 200: response(z.object({ id: z.string(), role: WorkspaceRole })), ...errors } }), async c => {
    const { id } = c.req.valid('param'), { role } = c.req.valid('json'); await changeMember(c, id, role); return c.json({ id, role }, 200);
  });
  app.openapi(createRoute({ method: 'delete', path: `${base}/members/{id}`, operationId: 'removeWorkspaceMember', tags, security, request: { params: IdParams }, responses: { 200: response(Removed), ...errors } }), async c => {
    const { id } = c.req.valid('param'); await changeMember(c, id); return c.json({ id, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: `${base}/invitations`, operationId: 'listWorkspaceInvitations', tags, security, description: `List pending, unexpired workspace invitations. ${inPerson}`, responses: { 200: response(z.object({ data: z.array(Invitation) })), ...errors } }), async c => {
    const a = memberAdmin(c, false);
    const result = await c.env.db.execute<InviteRow>(sql`SELECT id, workspace_id AS "workspaceId", email, role, expires_at AS "expiresAt" FROM workspace_invitations WHERE workspace_id = ${a.workspaceId} AND status = 'pending' AND expires_at > now() ORDER BY email`);
    return c.json({ data: result.rows.map(row => invitationView(c, row)) }, 200);
  });
  app.openapi(createRoute({ method: 'delete', path: `${base}/invitations`, operationId: 'revokeWorkspaceInvitation', tags, security, description: `Revoke a pending invitation; its link stops working. Only an owner revokes an owner invitation. ${inPerson}`, request: { query: IdParams }, responses: { 200: response(Removed), ...errors } }), async c => {
    const { id } = c.req.valid('query'), caller = memberAdmin(c, true);
    await administer(c, async (db, wid, _uid, role) => {
      const result = await db.execute(sql`WITH revoked AS (UPDATE workspace_invitations SET status = 'canceled' WHERE id = ${id} AND workspace_id = ${wid} AND status = 'pending' AND (role <> 'owner' OR ${role} = 'owner') RETURNING id, email, role),
        audit AS (${auditInsert(auditContext(c), { action: 'member.invite_revoke', workspaceId: wid, userId: null, target: { type: 'invitation', id: sql`revoked.id` }, before: sql`jsonb_build_object('email', revoked.email, 'role', revoked.role)` }, { from: sql`revoked` })})
        SELECT id FROM revoked`);
      if (!result.rowCount) notFound('Invitation');
    }, caller);
    return c.json({ id, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/workspaces/invitations/{id}', operationId: 'getWorkspaceInvitation', tags, security,
    description: 'Shows the signed-in recipient the invitation they followed (the workspace’s and the inviter’s names as plain words, the inviter’s address, the role). Read-only; acceptWorkspaceInvitation joins.',
    request: { params: IdParams }, responses: { 200: response(InvitationPreview), ...errors } }), async c => {
    if (!c.env.config.multiTenant) return notFound('Endpoint');
    const a = await verifiedDashboardUser(c.env, c.req.raw.headers,true), invitationId = c.req.valid('param').id;
    // Same conditions as claimInvitation for a pending invitation, plus the idempotent accepted case.
    const result = await c.env.db.execute<z.infer<typeof InvitationPreview>>(sql`SELECT i.id, i.workspace_id AS "workspaceId", w.name AS "workspaceName", w.slug AS "workspaceSlug",
        u.name AS "inviterName", CASE WHEN u.email_verified THEN coalesce(u.email, '') ELSE '' END AS "inviterEmail", i.role, i.expires_at AS "expiresAt", CASE WHEN i.status = 'accepted' THEN 'accepted' ELSE 'pending' END AS status
      FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id JOIN nightmail_users u ON u.id = i.inviter_id
      ${invitationInviterJoin}
      WHERE ${claimableInvitationWhere(invitationId, a.email, a.userId)}`);
    const row = result.rows[0] ?? notFound('Invitation');
    // The names are the inviting account's to choose and this page speaks for the product: plain words only, as in its emails.
    return c.json(InvitationPreview.parse({ ...row, workspaceName: shownName(row.workspaceName), inviterName: shownName(row.inviterName), expiresAt: new Date(row.expiresAt).toISOString() }), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/workspaces/invitations/{id}/accept', operationId: 'acceptWorkspaceInvitation', tags, security, request: { params: IdParams }, responses: { 200: response(z.object({ workspaceId: z.string() })), ...errors } }), async c => {
    if (!c.env.config.multiTenant) return notFound('Endpoint');
    const a = await invitationRecipient(c.env, c.req.raw), invitationId = c.req.valid('param').id;
    const workspaceId = await claimInvitation(c.env.db, a.userId, a.email, invitationId, auditContext(c));
    if (workspaceId) return c.json({ workspaceId }, 200);
    // Following the URL immediately after sign-in is an idempotent success, never a rejoin.
    const existing = await c.env.db.execute<{ workspace_id: string }>(sql`SELECT i.workspace_id FROM workspace_invitations i JOIN workspace_members m ON m.workspace_id = i.workspace_id AND m.user_id = ${a.userId} WHERE i.id = ${invitationId} AND i.email = ${a.email.toLowerCase()} AND i.status = 'accepted'`);
    return c.json({ workspaceId: existing.rows[0]?.workspace_id ?? notFound('Invitation') }, 200);
  });
}
