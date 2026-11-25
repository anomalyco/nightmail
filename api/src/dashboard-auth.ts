import {createRoute,z} from '@hono/zod-openapi';
import {and,asc,eq,isNotNull,sql} from 'drizzle-orm';
import type {BillingAccountRow} from './billing/state.js';
import {lists} from './db/audience.js';
import {ApiError,denied,digest,errors,isSimulatedSes,response,security,type App,type Runtime} from './core.js';
import {accountBrowserRoute,accountSessionActor,accountSessionUser,migrateLegacyCookies,requireDashboardOrigin,settleDefaultAccount} from './account-login.js';
import {Workspace,WorkspaceRole,sessionMemberships} from './workspaces.js';
import {ConnectionSummary,connectionSummary} from './provider-connections.js';
import { clientIpHeader, productName, requestedScopes } from './brand.js';
import { MAIL_PORTS } from './mail-servers.js';
import { TEST_SENDER_NAME } from './test-sender.js';
import { SEND_LIMITS } from './send-limits.js';

export async function reserveSignIn(runtime:Runtime,headers:Headers) {
  const peer=await digest(headers.get(clientIpHeader) ?? 'unknown');
  const result=await runtime.db.execute(sql`SELECT reserve_auth_state(${peer}) AS ok`);
  if (!result.rows[0]?.ok) throw new ApiError(429,'AUTH_STATE_LIMIT','Too many pending sign-ins. Try again later.');
}
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
    responses:{200:response(z.object({id:z.string(),workspaceId:z.string(),role:WorkspaceRole.nullable(),multiTenant:z.boolean(),simulated:z.boolean(),email:z.string().nullable(),name:z.string().nullable(),permissions:z.array(z.enum(['read','send','manage'])),domains:z.array(z.string()),origin:z.string().url(),host:z.string(),mcpScopes:z.array(z.string()).openapi({description:'The OAuth scopes this installation\'s MCP server asks for, for read, send and manage (nightmail:read …, or bane:read … until the account service supports nightmail:*).'}),connection:ConnectionSummary.nullable().openapi({description:'The current workspace\'s hosted sending connection; null when self-hosted.'}),workspaces:z.array(Workspace).nullable().openapi({description:'A hosted dashboard session\'s workspaces and roles (select one with X-Nightmail-Workspace); null for keys, MCP, agent tokens and self-hosted.'}),operator:z.enum(['operator','operator:read']).nullable().optional().openapi({description:`${productName} staff only: the platform operator role of this dashboard session (it opens /operator). Null for everyone else, and for a session that didn't sign in with Google.`}),staffSignIn:z.boolean().optional().openapi({description:`${productName} staff only: true when this person holds an operator role but this session didn't sign in with Google, which staff tools need. False otherwise.`}),uiNotes:z.boolean().optional().openapi({description:`${productName} staff only: this session may use staff UI notes. False for everyone else.`}),canCreateWorkspace:z.boolean().optional().openapi({description:'Dashboard sessions: whether createWorkspace lets this session create another workspace. Hosted, only staff can for now; everyone else has one workspace and gets 403 WORKSPACE_LIMIT. False for keys, MCP and agent tokens.'}),analytics:z.boolean().optional().openapi({description:'Whether this installation records how its dashboard is used (DASHBOARD_ANALYTICS). The dashboard sends nothing when false.'}),byo:z.boolean().optional().openapi({description:'Hosted dashboard sessions: an operator lets this workspace connect its own AWS account (POST /v1/connection with kind byo). False otherwise, and the dashboard offers Hosted mail only.'}),presence:z.boolean().optional().openapi({description:'Whether this installation shows who else has a campaign open in the dashboard (campaign rooms run on the Cloudflare deployment). False on the Node server.'}),
      billing:z.object({enforcement:z.enum(['off','shadow','enforce']),free:z.boolean().describe('Anomaly made this workspace free: never charged or paused for the balance.'),sending:z.enum(['ok','low','paused']),receiving:z.enum(['ok','grace','held']),autoRecharge:z.enum(['off','on','pending','failed','capped'])})
        .nullable().optional().openapi({description:'Hosted dashboard sessions: whether the workspace is free, whether an empty balance has paused sending or held received mail, and auto-recharge, so the dashboard can show it on its first frame. Null otherwise; GET /v1/billing has the detail.'}),
      newsletters:z.array(z.object({id:z.string(),name:z.string()})).nullable().openapi({description:'The workspace\u2019s oldest four newsletters (listNewsletters has them all), so a sidebar can name them on its first frame; a fourth means there are more. Null for a credential that cannot read lists (one without read, or limited to sender domains or addresses).'}),
      testSender:z.object({address:z.string(),name:z.string(),perDay:z.number().int(),perMinute:z.number().int()}).nullable().optional().openapi({description:`Hosted: the shared test sender. Until the workspace has a verified domain, sendEmail from this address sends to the verified address of a member of the workspace (their own), as name, at most perMinute and perDay recipients. Null when this installation has none.`}),
      mailServers:z.object({imap:z.string(),smtp:z.string()}).nullable().optional().openapi({description:`The hosts mail apps connect to: IMAP on ${MAIL_PORTS.imap.tls} (TLS) or ${MAIL_PORTS.imap.starttls} (STARTTLS), SMTP on ${MAIL_PORTS.smtp.tls} (TLS) or ${MAIL_PORTS.smtp.starttls} (STARTTLS). An app password signs in to both; a send-only API key signs in to SMTP as apikey. Null when this installation has no IMAP/SMTP gateway.`})})),...errors}}),async c=>{
    const identity=c.get('actor'), userId=identity.keyId.startsWith('user_')?identity.keyId.slice(5):null;
    const origin=new URL(c.env.config.publicUrl).origin, hosted=c.env.config.multiTenant;
    const dashboardUserId=hosted && identity.credential==='dashboard'?userId:null;
    const readsLists=!identity.domains.length && (identity.permissions.includes('read') || identity.permissions.includes('manage'));
    type Newsletter = {id:string;name:string};
    // At most four rows through the newsletters partial index, only for a credential that can read lists.
    const sidebarSource=readsLists?sql`FROM ${lists} WHERE ${and(eq(lists.workspaceId,identity.workspaceId),isNotNull(lists.newsletterFrom))}
      ORDER BY ${asc(lists.createdAt)}, ${asc(lists.id)} LIMIT 4`:null;
    const [connection,session,standaloneNewsletters]=await Promise.all([hosted?connectionSummary(c.env,identity.workspaceId):null,
      dashboardUserId?sessionMemberships(c.env.db,dashboardUserId):null,
      sidebarSource && !dashboardUserId?c.env.db.execute<Newsletter>(sql`SELECT ${lists.id}, ${lists.name} ${sidebarSource}`).then(({rows})=>rows):null]);
    // Staff UI notes: an operator in UI_NOTES_SUBJECTS only (operator-identity.ts); no query when the list is empty.
    const [uiNotes,billingAndNewsletters,byo]=await Promise.all([
      session?.operator==='operator' && identity.staff && userId ? import('./operator-identity.js').then(({uiNotesAllowed})=>uiNotesAllowed(c.env.db,c.env.config.uiNotesSubjects,userId)) : false,
      // Keep billing behind the session check, adding the sidebar to its statement only when lists are readable.
      session?import('./billing/state.js').then(async({billingAccountQuery,billingSummary,readBilling})=>{
        const view={amounts:false,received:false};
        const [b,newsletters]=sidebarSource?await c.env.db.execute<BillingAccountRow & {newsletters:Newsletter[]}>(sql`
          SELECT billing.*, to_json(ARRAY(SELECT json_build_object('id', ${lists.id}, 'name', ${lists.name}) ${sidebarSource})) AS newsletters
          FROM (${billingAccountQuery(identity.workspaceId)}) billing`).then(({rows:[row]})=>[billingSummary(row!,view),row!.newsletters] as const)
          :[await readBilling(c.env.db,identity.workspaceId,view),null] as const;
        return {billing:{enforcement:b.enforcement,free:b.mode==='exempt',...b.state},newsletters};
      }):null,
      session?import('./byo-pilot.js').then(({byoEnabled})=>byoEnabled(c.env,identity.workspaceId)):false]);
    const billing=billingAndNewsletters?.billing??null, newsletters=billingAndNewsletters?.newsletters??standaloneNewsletters;
    return c.json({id:userId??identity.keyId,workspaceId:identity.workspaceId,role:WorkspaceRole.nullable().parse(identity.role??null),multiTenant:hosted,simulated:isSimulatedSes(c.env),email:identity.email??null,name:identity.name??null,permissions:identity.permissions,domains:identity.domains,origin,host:new URL(origin).host,mcpScopes:requestedScopes(c.env.config),connection,workspaces:session?.workspaces??null,operator:identity.staff?session?.operator??null:null,staffSignIn:!!session?.operator&&!identity.staff,uiNotes,canCreateWorkspace:identity.credential==='dashboard'&&(!hosted||identity.staff===true),byo,presence:Boolean(c.env.campaignRooms),analytics:c.env.config.dashboardAnalytics===true,billing,newsletters,mailServers:c.env.config.mailServers??null,
      testSender:c.env.config.testSender?{address:c.env.config.testSender,name:TEST_SENDER_NAME,...SEND_LIMITS.testSender}:null},200);
  });
}
