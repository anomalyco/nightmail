import {createRoute,z} from '@hono/zod-openapi';
import {sql} from 'drizzle-orm';
import { ApiError, errors } from './core/errors.js';
import { digest, id, json, randomSecret, response, security } from './core/http.js';
import { receivingAdmin } from './core/access.js';
import type { App } from './core/types.js';
import {ownReceiving} from './rituals.js';
import {recordAudit} from './audit.js';
import {mailboxKeys} from './db/mailbox.js';
import {mcpClientConfig,mcpClientNames,mcpClients,mcpServerUrl} from './mcp-clients.js';
import { secretPrefixes, shownPrefix } from './brand.js';
// One connection: an inbox-only key inside a ready client config. The config comes from mcp-clients.ts, as in the
// dashboard and Docs. A sign-in can't be limited to inboxes, so auth=oauth is refused (it once pointed at a consent
// screen choice that no longer exists).
export function registerInboxConnection(app:App){
 const body=z.object({inboxes:z.array(z.string().min(1).max(120)).min(1).max(20),client:z.enum(mcpClients).describe('opencode, claude (Claude Code), cursor, or generic for any other MCP client.'),auth:z.enum(['key','oauth']).describe('key. oauth is refused with 422: a sign-in can’t be limited to inboxes.'),reply:z.boolean().default(false)}).strict();
 app.openapi(createRoute({method:'post',path:'/v1/inbox-connections',operationId:'createInboxConnection',tags:['Agent inboxes'],security,summary:'Create an inbox connection',description:'Key shown once. Generate client config with a key limited to selected inboxes.',request:{body:json(body)},responses:{201:response(z.object({id:z.string().nullable(),inboxes:z.array(z.string()),config:z.record(z.string(),z.unknown()),nextStep:z.string()})),...errors}}),async c=>{
  const a=receivingAdmin(c,'create inbox connections'),q=c.req.valid('json'),w=a.workspaceId,url=mcpServerUrl(c.env.config.publicUrl);
  if(q.auth==='oauth')throw new ApiError(422,'VALIDATION_FAILED','A sign-in can’t be limited to inboxes. Use auth:"key" for a key limited to these inboxes.','auth');
  const ids=[...new Set(q.inboxes)],key=randomSecret(secretPrefixes.addressKey),kid=id('mbk');
  await c.env.db.transaction(async tx=>{
   const found=await tx.execute<{expires:string|null;label:string}>(sql`SELECT delete_after::text AS expires,coalesce(nullif(display_name,''),address) AS label FROM mailboxes WHERE workspace_id=${w} AND id=ANY(${sql.param(ids)}::text[]) AND kind='inbox' AND (delete_after IS NULL OR delete_after>now()) ORDER BY delete_after DESC FOR SHARE`);
   if(found.rowCount!==ids.length)throw new ApiError(422,'UNKNOWN_INBOX','Choose active inboxes in this workspace.','inboxes');
   // Named for what it opens and who uses it, so several connections stay told apart: "Support triage · OpenCode".
   const what=found.rows.length===1?found.rows[0]!.label:`${found.rows.length} inboxes`;
   await tx.insert(mailboxKeys).values({id:kid,workspaceId:w,name:`${what} · ${mcpClientNames[q.client]}`.slice(0,100),hash:await digest(key),prefix:shownPrefix(key),expiresAt:found.rows[0]!.expires,mailboxIds:ids,permissions:q.reply?['read','send']:['read']});
   await ownReceiving(tx,c,'key',kid);
   await recordAudit(tx,c,{action:'inbox_connection.create',workspaceId:w,target:{type:'inbox_key',id:kid},after:{client:q.client,auth:q.auth,inboxIds:ids,permissions:q.reply?['read','send']:['read']}});
  });
  const config=mcpClientConfig(q.client,url,{bearer:key});
  c.header('Cache-Control','no-store');
  return c.json({id:kid,inboxes:ids,config,nextStep:'Copy the config to your agent. The bearer key is shown only once.'},201);
 });
}
