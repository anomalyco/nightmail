import {createRoute,z} from '@hono/zod-openapi';
import {and,asc,eq,isNotNull,sql} from 'drizzle-orm';
import type {BillingAccountRow} from './billing/state.js';
import {uiNotesAllowedQuery} from './operator-identity.js';
import {lists} from './db/audience.js';
import {ApiError,denied,errors,isSimulatedSes,response,security,timed,type App,type Runtime} from './core.js';
import {accountBrowserRoute,accountSessionActor,accountSessionUser,migrateLegacyCookies,requireDashboardOrigin,settleDefaultAccount} from './account-login.js';
import {Workspace,WorkspaceRole,sessionMembershipsQuery,type SessionMembershipRow} from './workspaces.js';
import {ConnectionSummary,connectionSummaryQuery,connectionSummaryOf,type ConnectionSummaryRow,HOSTED_STARTING_SECONDS} from './provider-connections.js';
import { productName, requestedScopes } from './brand.js';
import { MAIL_PORTS } from './mail-servers.js';
import { WORKSPACE_FOCUS } from './workspace-focus.js';

export async function verifiedDashboardUser(runtime:Runtime,headers:Headers,requireCurrentEmail=false) {
  // A bearer credential (API key, MCP or agent token) never rides the session cookie. It is refused with 403, as on
  // every other dashboard-only route (core.ts); 401 is for a caller with no session at all.
  if (headers.has('authorization')) throw denied('DASHBOARD_AUTH_REQUIRED','Use a signed-in dashboard session.',{credential:'dashboard'});
  const user=await accountSessionUser(runtime,headers,requireCurrentEmail);
  // Signed in, but this session's sign-in proves no mailbox for the account's address (hosted: an emailed link or code
  // does, or Google for a Google-hosted one; account-policy.ts provenMailbox). What is bound to an address needs one.
  if (!user && requireCurrentEmail && runtime.config.multiTenant && await accountSessionUser(runtime,headers))
    throw new ApiError(403,'MAILBOX_SIGN_IN_REQUIRED','Sign in with an emailed link to this address, or its Google account, to continue.');
  if (!user) throw new ApiError(401,'AUTH_REQUIRED',`Sign in to ${productName}.`);
  return {userId:user.id,email:user.email};
}
export async function invitationRecipient(runtime:Runtime,request:Request) {
  requireDashboardOrigin(runtime,request);
  return verifiedDashboardUser(runtime,request.headers,true);
}
export const getDashboardActor = accountSessionActor;
export { migrateLegacyCookies, requireDashboardOrigin, settleDefaultAccount };
export function registerDashboardAuth(app: App) {
  app.on(['GET','POST','OPTIONS'],'/api/auth/*',accountBrowserRoute);
  app.openapi(createRoute({method:'get',path:'/v1/me',operationId:'getCurrentIdentity',tags:['Auth'],security,
    responses:{200:response(z.object({id:z.string(),workspaceId:z.string(),role:WorkspaceRole.nullable(),multiTenant:z.boolean(),simulated:z.boolean(),email:z.string().nullable(),name:z.string().nullable(),permissions:z.array(z.enum(['read','send','manage'])),domains:z.array(z.string()),origin:z.string().url(),host:z.string(),mcpScopes:z.array(z.string()).openapi({description:'The OAuth scopes this installation\'s MCP server asks for, for read, send and manage (nightmail:read …, or bane:read … until the account service supports nightmail:*).'}),connection:ConnectionSummary.nullable().openapi({description:'The current workspace\'s hosted sending connection; null when self-hosted.'}),hostedSetup:z.enum(['starting']).nullable().optional().openapi({description:'A hosted dashboard session in a workspace made seconds ago whose Hosted mail (its connection and built-in domain) is still being written: starting. Read /v1/me again shortly; null otherwise.'}),focus:z.array(z.enum(WORKSPACE_FOCUS)).nullable().optional().openapi({description:'A hosted dashboard session: what this workspace is here for, the first leading (focus in getWorkspaceSettings, which changes it). Null until chosen or for other credentials; empty when skipped.'}),
      workspaces:z.array(Workspace).nullable().openapi({description:'A hosted dashboard session\'s workspaces and roles (select one with X-Nightmail-Workspace); null for keys, MCP, agent tokens and self-hosted.'}),operator:z.enum(['operator','operator:read']).nullable().optional().openapi({description:`${productName} staff only: the platform operator role of this dashboard session (it opens /operator). Null for everyone else, and for a session that didn't sign in with Google.`}),staffSignIn:z.boolean().optional().openapi({description:`${productName} staff only: true when this person holds an operator role but this session didn't sign in with Google, which staff tools need. False otherwise.`}),uiNotes:z.boolean().optional().openapi({description:`${productName} staff only: this session may use staff UI notes. False for everyone else.`}),canCreateWorkspace:z.boolean().optional().openapi({description:'Dashboard sessions: whether createWorkspace lets this session create another workspace. Hosted, only staff can for now; everyone else has one workspace and gets 403 WORKSPACE_LIMIT. False for keys, MCP and agent tokens.'}),analytics:z.boolean().optional().openapi({description:'Whether this installation records how its dashboard is used (DASHBOARD_ANALYTICS). The dashboard sends nothing when false.'}),byo:z.boolean().optional().openapi({description:'Hosted dashboard sessions: an operator lets this workspace connect its own AWS account (POST /v1/connection with kind byo). False otherwise, and the dashboard offers Hosted mail only.'}),presence:z.boolean().optional().openapi({description:'Whether this installation shows who else has a campaign open in the dashboard (campaign rooms run on the Cloudflare deployment). False on the Node server.'}),
      billing:z.object({enforcement:z.enum(['off','shadow','enforce']),free:z.boolean().describe('Anomaly made this workspace free: never charged or paused for the balance.'),sending:z.enum(['ok','low','paused']),receiving:z.enum(['ok','grace','held']),autoRecharge:z.enum(['off','on','pending','failed','capped'])})
        .nullable().optional().openapi({description:'Hosted dashboard sessions: whether the workspace is free, whether an empty balance has paused sending or held received mail, and auto-recharge, so the dashboard can show it on its first frame. Null otherwise; GET /v1/billing has the detail.'}),
      newsletters:z.array(z.object({id:z.string(),name:z.string()})).nullable().openapi({description:'The workspace\u2019s oldest four newsletters (listNewsletters has them all), so a sidebar can name them on its first frame; a fourth means there are more. Null for a credential that cannot read lists (one without read, or limited to sender domains or addresses).'}),
      mailServers:z.object({imap:z.string(),smtp:z.string()}).nullable().optional().openapi({description:`The hosts mail apps connect to: IMAP on ${MAIL_PORTS.imap.tls} (TLS) or ${MAIL_PORTS.imap.starttls} (STARTTLS), SMTP on ${MAIL_PORTS.smtp.tls} (TLS) or ${MAIL_PORTS.smtp.starttls} (STARTTLS). An app password signs in to both; a send-only API key signs in to SMTP as apikey. Null when this installation has no IMAP/SMTP gateway.`})})),...errors}}),async c=>{
    const identity=c.get('actor'), userId=identity.keyId.startsWith('user_')?identity.keyId.slice(5):null;
    const origin=new URL(c.env.config.publicUrl).origin, hosted=c.env.config.multiTenant;
    const dashboardUserId=hosted && identity.credential==='dashboard'?userId:null;
    const readsLists=!identity.domains.length && (identity.permissions.includes('read') || identity.permissions.includes('manage'));
    type Newsletter = {id:string;name:string};
    // At most four rows through the newsletters partial index, only for a credential that can read lists.
    const sidebarSource=readsLists?sql`FROM ${lists} WHERE ${and(eq(lists.workspaceId,identity.workspaceId),isNotNull(lists.newsletterFrom))}
      ORDER BY ${asc(lists.createdAt)}, ${asc(lists.id)} LIMIT 4`:null;
    // The live credential check has already selected the workspace. Read its first frame in one snapshot:
    // Promise.all on the Worker's one-connection pool only queues more round trips.
    const wid=identity.workspaceId, subjects=c.env.config.uiNotesSubjects;
    const billingModule=dashboardUserId ? await import('./billing/state.js') : null;
    type Frame = { connection: ConnectionSummaryRow | null; session: SessionMembershipRow | null; billing: BillingAccountRow | null; newsletters: Newsletter[] | null; ui_notes: boolean };
    const row = hosted || sidebarSource ? (await timed(c,'me-db',()=>c.env.db.execute<Frame>(sql`SELECT
      ${hosted ? sql`(SELECT row_to_json(v) FROM (${connectionSummaryQuery(c.env,wid)}) v)` : sql`NULL`} AS connection,
      ${dashboardUserId ? sql`(SELECT row_to_json(s) FROM (${sessionMembershipsQuery(dashboardUserId,wid)}) s)` : sql`NULL`} AS session,
      ${billingModule ? sql`(SELECT row_to_json(b) FROM (${billingModule.billingAccountQuery(wid)}) b)` : sql`NULL`} AS billing,
      ${sidebarSource ? sql`to_json(ARRAY(SELECT json_build_object('id', ${lists.id}, 'name', ${lists.name}) ${sidebarSource}))` : sql`NULL`} AS newsletters,
      ${dashboardUserId && identity.staff && subjects?.length ? uiNotesAllowedQuery(subjects,dashboardUserId) : sql`false`} AS ui_notes`))).rows[0] : undefined;
    const connection=connectionSummaryOf(c.env,row?.connection), session=row?.session;
    const b=billingModule && row?.billing ? billingModule.billingSummary(row.billing,{amounts:false,received:false}) : null;
    const billing=b ? {enforcement:b.enforcement,free:b.mode==='exempt',...b.state} : null;
    const newsletters=row?.newsletters??null, uiNotes=row?.ui_notes===true, byo=!!c.env.config.byoV2 && session?.byo===true;
    // A sign-up writes its Hosted mail after answering (startHostedMailAfter): /v1/me never waits for it, it says so.
    const hostedSetup=hosted && c.env.config.builtinDomain && session && (session.ageSeconds??Infinity)<HOSTED_STARTING_SECONDS && (!connection || (connection.kind==='shared' && !connection.builtinDomain)) ? 'starting' as const : null;
    return c.json({id:userId??identity.keyId,workspaceId:identity.workspaceId,role:WorkspaceRole.nullable().parse(identity.role??null),multiTenant:hosted,simulated:isSimulatedSes(c.env),email:identity.email??null,name:identity.name??null,permissions:identity.permissions,domains:identity.domains,origin,host:new URL(origin).host,mcpScopes:requestedScopes(c.env.config),connection,hostedSetup,focus:session?.focus??null,workspaces:session?.workspaces.map(w=>Workspace.parse(w))??null,operator:identity.staff?session?.operator??null:null,staffSignIn:!!session?.operator&&!identity.staff,uiNotes,canCreateWorkspace:identity.credential==='dashboard'&&(!hosted||identity.staff===true),byo,presence:Boolean(c.env.campaignRooms),analytics:c.env.config.dashboardAnalytics===true,billing,newsletters,mailServers:c.env.config.mailServers??null},200);
  });
}
