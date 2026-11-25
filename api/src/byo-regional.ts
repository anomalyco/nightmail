import { sql } from 'drizzle-orm';
import { z } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { ApiError, denied, id, lazyModule, log, ModuleLoadError, notFound, type Runtime, type DbExecutor, type JobHandler } from './core.js';
import { productName } from './brand.js';
import { assume, brokerRoleArn, loadStsSdk } from './provider-credentials.js';
import { BYO_TEMPLATE_VERSIONS, byoSessionPolicy, byoTemplateUrl, versionAtLeast, type ByoPurpose } from './byo-permissions.js';
import { requirePlatformAccount } from './config.js';
import { awsError, byoFeedbackUrl, loadSetupSdk, provisionJournaledFeedback, readSelectedDomains, removeByoFeedbackResource, scanRegionPage, setupResources, type Inventory, type CandidateIdentity, type JournalEntry, type ScanStage, byoStackName } from './ses-setup.js';
import { JobDeferred, retryDatabaseFailures } from './jobs.js';
import { acquireRegionProvisioning, campaignReserved, finishRegionProvisioning, verifyImportedClaims } from './states.js';
import { claimNameAllowed, domainClaimed, domainLimitError, releaseConnectionClaims } from './domain-claims.js';
import { getRegionSettings } from './ses-region-state.js';
import { lockSendScope } from './send-scope.js';
import { byoEnabled } from './byo-pilot.js';
import { recordAudit, systemContext } from './audit.js';
import { regionLabels } from './region-labels.js';

export { regionLabels } from './region-labels.js';
export type V5Connection={id:string;stack_name:string|null;workspace_id:string;requested_account:string|null;stack_id:string|null;stack_template_version:string|null;stack_deleted_at:string|null;stack_error:string|null;resource_prefix:string;disconnect_summary:z.infer<typeof DisconnectSummary>|null;health:{checkedAt:string;issues:{code:string;region?:string;message:string}[]}|null;aws_account_id:string|null;role_arn:string|null;external_id:string;inventory_revision:number;state:string;region:string;disconnect_error:{region:string|null;code:string}|null};
type ScanRow={region:string;scan_state:string;scan_error:string|null;scan_facts:Inventory;scan_revision:string;sending_state:string;receiving_state:string;provision_error:string|null;ownership_journal:JournalEntry[]};
const conflict=(code:string,message:string)=>new ApiError(409,code,message);
const stale=()=>conflict('SCAN_STALE','Refresh the list and select verified domains from a completed regional scan.');
const defer=(ms:number,payload?:Record<string,unknown>)=>new JobDeferred(new Date(Date.now()+ms).toISOString(),payload);
async function writable(r:Runtime,wid:string,db?:DbExecutor) {
  if (!await byoEnabled(r,wid,db)) return notFound('Endpoint');
  if (!r.config.regionalSending) throw conflict('REGIONAL_SENDING_REQUIRED','Enable regional sending before enrolling a regional AWS connection.');
}
async function connection(db:DbExecutor,wid:string,lock=false) {
  return (await db.execute<V5Connection>(sql`SELECT * FROM provider_connections WHERE workspace_id=${wid} AND template_version='v5' AND kind='byo' ${lock?sql`FOR UPDATE`:sql``}`)).rows[0];
}
export async function requiredV5(r:Runtime,wid:string) {
  await writable(r,wid);return usable(await connection(r.db,wid));
}
function usable(c:V5Connection|undefined) {
  if (!c) return notFound('Regional connection');
  if (c.state==='disconnecting') throw conflict('CONNECTION_DISCONNECTING','Regional cleanup is in progress.');
  return c;
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
type Op={operationId:string;regions:string[]};
type ScanOp={operationId:string;revision:number};
function receipt<T extends Op|ScanOp>(c:V5Connection,operation:string,key:string|undefined,body:string) {
  if (key!==undefined && !/^[\x21-\x7e]{1,200}$/.test(key)) throw new ApiError(422,'INVALID_IDEMPOTENCY_KEY','Use 1–200 printable ASCII characters.');
  const request=hash(body), keyHash=key?hash(key):null;
  return {read:async(db:DbExecutor)=>{
    if (!keyHash) return;
    const prior=(await db.execute<{request_hash:string;result:T}>(sql`SELECT request_hash,result FROM byo_operation_receipts WHERE connection_id=${c.id} AND operation=${operation} AND key_hash=${keyHash}`)).rows[0];
    if (prior && prior.request_hash!==request) throw conflict('IDEMPOTENCY_KEY_REUSED','This idempotency key was used with a different request.');
    return prior?.result;
  },save:async(db:DbExecutor,result:T)=>{
    if (keyHash) await db.execute(sql`INSERT INTO byo_operation_receipts VALUES(${c.id},${operation},${keyHash},${request},${JSON.stringify(result)}::jsonb)`);return result;
  }};
}
const candidateId=(region:string,name:string)=>region+':'+name;
const proofId=(c:V5Connection)=>`byo.prove:${c.id}:${c.inventory_revision}`;
const regionJobId=(c:V5Connection,region:string)=>`byo.provision:${c.id}:${region}`;
const job=(db:DbExecutor,c:V5Connection,type:string,jobId:string,extra:Record<string,unknown>={})=>db.execute(sql`INSERT INTO jobs(id,workspace_id,type,payload) VALUES(${jobId},${c.workspace_id},${type},${JSON.stringify({connectionId:c.id,...extra,run:id('run')})}::jsonb)
  ON CONFLICT(id) DO UPDATE SET status='pending',available_at=now(),attempts=0,last_error=NULL,lease_until=NULL,payload=excluded.payload WHERE jobs.status IN ('completed','failed')`);

// The role template (api/byo-templates/) takes every value as a plain parameter: quick-create links ignore NoEcho ones.
export function v5Link(r:Runtime,c:{id:string;workspace_id:string;external_id:string|null;region:string;stack_name?:string|null}) {
  if (!r.config.byoV5TemplateUrl) throw new ApiError(503,'BYO_NOT_CONFIGURED','The v5 role template URL is not configured.');
  const params=new URLSearchParams({templateURL:r.config.byoV5TemplateUrl,stackName:c.stack_name ?? byoStackName('Nightmail',c.id),param_PlatformAccount:requirePlatformAccount(r.config.platformAccount),
    param_ExternalId:c.external_id!,param_ConnectionId:c.id,param_WorkspaceId:c.workspace_id,param_ResourcePrefix:setupResources(c.id,'byo').topicName.slice(0,-9),param_EventsHost:new URL(byoFeedbackUrl(r.config)).hostname});
  return `https://${c.region}.console.aws.amazon.com/cloudformation/home?region=${c.region}#/stacks/create/review?${params}`;
}
// The account is optional: the stack reports its own account when it's created (stackNotification), so nothing has to
// be typed. Given, it's checked against the stack's, and it starts the polling proof (the manual path).
export async function enrollV5(r:Runtime,wid:string,account?:string) {
  // The template trusts the platform account through its broker role only, which may assume only Nightmail-<20> roles.
  const platformAccount=requirePlatformAccount(r.config.platformAccount),platformArn=brokerRoleArn(r);
  if (account===platformAccount) throw conflict('AWS_ACCOUNT_IN_USE','The shared sending account cannot be connected.');
  const cid=id('conn'),roleRegion='us-east-2',external=crypto.randomUUID();
  v5Link(r,{id:cid,region:roleRegion,workspace_id:wid,external_id:external,stack_name:byoStackName('Nightmail',cid)});
  return r.db.transaction(async db=>{
    await writable(r,wid,db);
    const inserted=await db.execute(sql`INSERT INTO provider_connections(id,workspace_id,kind,region,state,tenant_state,external_id,platform_principal_arn,template_version,resource_prefix,requested_account,inventory_revision,stack_name)
      VALUES(${cid},${wid},'byo',${roleRegion},'awaiting_role','ready',${external},${platformArn},'v5',${setupResources(cid,'byo').topicName.slice(0,-9)},${account??null},1,${byoStackName('Nightmail',cid)}) ON CONFLICT(workspace_id) DO NOTHING`);
    const c=await connection(db,wid,true);if (c) usable(c);
    if (!c) throw conflict('CONNECTION_EXISTS','A different sending connection already exists.');
    if (account!==undefined && c.requested_account!==account) {
      if (c.requested_account!==null || c.aws_account_id) throw conflict('CONNECTION_EXISTS','A different sending connection already exists.');
      await db.execute(sql`UPDATE provider_connections SET requested_account=${account} WHERE id=${c.id} AND requested_account IS NULL AND aws_account_id IS NULL`);
      c.requested_account=account;await job(db,c,'byo.prove',proofId(c),{revision:c.inventory_revision});
    } else if (inserted.rowCount && account!==undefined) await job(db,c,'byo.prove',proofId(c),{revision:c.inventory_revision});
    return {operationId:proofId(c),revision:c.inventory_revision};
  });
}

// Inline STS policies intersect with v5's tag, endpoint, and trust conditions. No
// scanner can send, provision, or read an email address identity; provisioning cannot
// read other sets/topics. The proof probes use the same limited policy.
async function scoped(r:Runtime,c:V5Connection,region:string,purpose:Extract<ByoPurpose,'scan'|'provision'|'cleanup'|'stack'>,verify=false) {
  const account=c.requested_account ?? '', role=`arn:aws:iam::${account}:role/${c.stack_name ?? byoStackName('Bane',c.id)}`;
  if (account===requirePlatformAccount(r.config.platformAccount) || !/^\d{12}$/.test(account) || !(region in regionLabels) || (!verify && (c.aws_account_id!==account || c.role_arn!==role))) throw conflict('AWS_ACCOUNT_MISMATCH','The regional role is not bound to this account.');
  const aws=await assume(r,region,role,c.external_id,verify,byoSessionPolicy(purpose,{region,account,connectionId:c.id,stack:c.stack_name??undefined}),{connectionId:c.id,purpose});
  // The feedback subscription goes to the one endpoint the role allows (EventsHost).
  return {...r,config:{...r.config,workspaceId:c.workspace_id,aws,awsAccountId:account,sesFeedbackUrl:byoFeedbackUrl(r.config)}};
}
async function beginScan(db:DbExecutor,c:V5Connection) {
  await db.execute(sql`DELETE FROM byo_candidates WHERE connection_id=${c.id}`);
  await db.execute(sql`WITH regions AS (INSERT INTO provider_connection_regions(connection_id,region,managed_tenant,tenant_state,scan_revision,scan_state)
    SELECT ${c.id},region,false,'ready',${c.inventory_revision},'scanning' FROM jsonb_array_elements_text(${JSON.stringify(Object.keys(regionLabels))}::jsonb) rs(region)
    ON CONFLICT(connection_id,region) DO UPDATE SET scan_revision=excluded.scan_revision,scan_state='scanning',scan_error=NULL,scan_facts='{}' RETURNING region)
    INSERT INTO jobs(id,type,workspace_id,payload) SELECT ${'byo.scan:'+c.id+':'+c.inventory_revision+':'}||region,'byo.scan',${c.workspace_id},
      jsonb_build_object('connectionId',${c.id}::text,'region',region,'revision',${c.inventory_revision}::integer,'stage','account','run',gen_random_uuid()) FROM regions`);
}
export async function refreshScan(r:Runtime,wid:string,key?:string) {
  await writable(r,wid);return r.db.transaction(async db=>{
    const c=usable(await connection(db,wid,true));
    const op=receipt<ScanOp>(c,'scan',key,''),prior=await op.read(db);if (prior) return prior;
    // Not connected yet: the stack reports itself, or (manual path) the typed account is proved.
    if (!c.aws_account_id) { if (c.requested_account) await job(db,c,'byo.prove',proofId(c),{revision:c.inventory_revision});return op.save(db,{revision:c.inventory_revision,operationId:proofId(c)}); }
    if (!(await db.execute(sql`SELECT FROM provider_connection_regions WHERE connection_id=${c.id} AND scan_state='scanning' LIMIT 1`)).rowCount) {
      c.inventory_revision++;await db.execute(sql`UPDATE provider_connections SET inventory_revision=${c.inventory_revision},state=CASE WHEN state='ready' THEN state ELSE 'scanning' END WHERE id=${c.id}`);await beginScan(db,c);
    }
    return op.save(db,{revision:c.inventory_revision,operationId:`byo.scan:${c.id}:${c.inventory_revision}`});
  });
}
const runV5=(handler:(r:Runtime,c:V5Connection,p:Record<string,unknown>,attempt:number)=>Promise<void>):JobHandler=>retryDatabaseFailures(async(r,p,j)=>{
  // Preserve accepted work on rollout pause, without touching AWS or consuming attempts.
  if (!r.config.regionalSending || !await byoEnabled(r,j.workspaceId)) throw defer(300_000);
  const c=await connection(r.db,j.workspaceId);if (!c || c.id!==p.connectionId || c.state==='disconnecting') return;
  await handler(r,c,p,j.attempts);
});
const prove=runV5(async(r,c,p)=>{
  if (c.aws_account_id || !c.requested_account || p.revision!==c.inventory_revision) return;
  try { await scoped(r,c,c.region,'scan',true); }
  catch(e) {
    if (e instanceof ModuleLoadError) throw e;
    const err=awsError(e);if (err.code==='AWS_ACCESS_DENIED' || err.retryable) throw defer(30_000);
    await r.db.execute(sql`UPDATE provider_connections SET state='failed' WHERE id=${c.id} AND aws_account_id IS NULL`);throw err;
  }
  try {
    await r.db.transaction(async db=>{
      if (!(await db.execute(sql`UPDATE provider_connections SET aws_account_id=requested_account,role_arn=${`arn:aws:iam::${c.requested_account}:role/${c.stack_name ?? byoStackName('Bane',c.id)}`},state='scanning' WHERE id=${c.id} AND aws_account_id IS NULL`)).rowCount) return;
      await beginScan(db,c);
    });
  } catch(e) {
    if ((e as {cause?:{constraint?:string}}).cause?.constraint!=='provider_connections_byo_account') throw e;
    await r.db.execute(sql`UPDATE provider_connections SET state='failed' WHERE id=${c.id} AND aws_account_id IS NULL`);throw conflict('AWS_ACCOUNT_IN_USE','This AWS account is already connected.');
  }
});
const scan=runV5(async(r,c,p)=>{
  if (p.revision!==c.inventory_revision) return;
  const region=String(p.region),stage=p.stage as ScanStage,token=p.token as string|undefined;
  const guard=sql`connection_id=${c.id} AND region=${region} AND scan_revision=${c.inventory_revision} AND scan_state='scanning'`;
  const terminal=async(db:DbExecutor)=>db.execute(sql`UPDATE provider_connections SET state=CASE WHEN EXISTS(SELECT FROM provider_connection_regions WHERE connection_id=${c.id} AND scan_state='ready_to_import') THEN 'ready_to_import' ELSE 'failed' END WHERE id=${c.id} AND inventory_revision=${c.inventory_revision} AND state='scanning'
    AND NOT EXISTS(SELECT FROM provider_connection_regions WHERE connection_id=${c.id} AND scan_state='scanning')`);
  const fail=(code:string)=>r.db.transaction(async db=>{await connection(db,c.workspace_id,true);await db.execute(sql`UPDATE provider_connection_regions SET scan_state='failed',scan_error=${code} WHERE ${guard}`);await terminal(db);});
  let page;
  try { page=await scanRegionPage(await scoped(r,c,region,'scan'),region,c.id,stage,token); }
  catch(e) { if (e instanceof ModuleLoadError) throw e; await fail(awsError(e).code);return; }
  const facts=page.facts;
  const seen=(p.seen as string[]|undefined)??[], fingerprint=page.next?.token?hash(page.next.token):null;
  if (fingerprint && seen.includes(fingerprint)) { await fail('SES_PAGINATION_STALLED');return; }
  const updated=await r.db.transaction(async db=>{
    if (!page.next) await connection(db,c.workspace_id,true);
    if (!(await db.execute(sql`UPDATE provider_connection_regions SET scan_facts=scan_facts||${JSON.stringify(facts)}::jsonb ${facts.configurationSets ? sql`||jsonb_build_object('configurationSets',coalesce(scan_facts->'configurationSets','{}')||${JSON.stringify(facts.configurationSets)}::jsonb)` : sql``},scan_state=${page.next?'scanning':'ready_to_import'} WHERE ${guard}`)).rowCount) return false;
    for (const d of page.domains) await db.execute(sql`INSERT INTO byo_candidates VALUES(${c.id},${region},${d.name},${c.inventory_revision},${JSON.stringify(d.identity)}::jsonb) ON CONFLICT(connection_id,region,name) DO UPDATE SET identity=excluded.identity`);
    if (!page.next) await terminal(db);
    return true;
  });
  if (updated && page.next) throw defer(1050,{...p,...page.next,token:page.next.token??null,seen:fingerprint?[...seen,fingerprint]:[]});
});

const Candidate=z.object({id:z.string(),domain:z.string(),region:z.string(),regionLabel:z.string(),selectable:z.boolean(),status:z.enum(['verified','signing_pending','not_verified','incomplete','already_bound','overlap']),sandbox:z.boolean().nullable(),defaultConfigurationSet:z.string().nullable(),dkimStatus:z.string().nullable(),signingOrigin:z.string().nullable(),mailFromDomain:z.string().nullable(),overlap:z.boolean()});
const Facts=z.object({production:z.boolean().optional(),review:z.object({status:z.string(),caseId:z.string().nullable()}).nullable().optional().describe('AWS\'s review of a production access request.'),enforcement:z.string().optional(),sendingEnabled:z.boolean().optional(),max24HourSend:z.number().optional(),maxSendRate:z.number().optional(),sentLast24Hours:z.number().optional(),configurationSets:z.record(z.string(),z.object({installation:z.boolean().nullable()})).optional(),receiving:z.object({supported:z.boolean(),set:z.string().nullable(),rules:z.array(z.object({name:z.string(),enabled:z.boolean(),recipients:z.array(z.string()),actions:z.array(z.string())}))}).optional()});
const Pending=z.object({domain:z.string(),importing:z.boolean(),error:z.string().nullable()});
const FailedIntent=Pending.extend({error:z.string()});
const Region=z.object({region:z.string(),regionLabel:z.string(),scanState:z.string(),scanError:z.string().nullable(),sendingState:z.string(),receivingState:z.string(),error:z.string().nullable(),facts:Facts,resources:z.array(z.object({kind:z.string(),resource:z.string(),target:z.string().optional(),state:z.enum(['creating','created']).optional()})),pending:z.array(Pending),failedIntents:z.array(FailedIntent)});
export const RegionStatus=z.object({regions:z.array(Region)});
export const ScanView=z.object({revision:z.number(),cursor:z.object({checked:z.number(),total:z.number()}),state:z.enum(['awaiting_role','failed','scanning','partial','ready_to_import']),error:z.string().nullable(),alreadySendsEmail:z.boolean().nullable(),regions:z.array(Region)});
// What a disconnect keeps in the customer's account (their SES identities, with the DNS records of those Nightmail
// created) and what it couldn't remove. Recorded when sending is fenced, shown while the cleanup runs.
const DnsRecord=z.object({type:z.enum(['CNAME','MX','TXT']),name:z.string(),value:z.string(),priority:z.number().int().optional()}).openapi('DisconnectDnsRecord');
export const DisconnectSummary=z.object({
  retained:z.array(z.object({domain:z.string(),region:z.string(),regionLabel:z.string(),createdByNightmail:z.boolean().describe(`${productName} created the identity; otherwise it was already in the account.`),records:z.array(DnsRecord).describe(`DNS records of an identity ${productName} created, to remove with it.`)}))
    .describe('SES identities that stay in the AWS account. Delete one in the SES console, and its DNS records, once nothing sends from it.'),
  leftBehind:z.array(z.object({region:z.string(),kind:z.string(),resource:z.string()})).describe(`Resources ${productName} created but couldn't remove: its role was gone, or they were changed in AWS.`),
  stack:z.object({name:z.string(),consoleUrl:z.url()}).nullable().describe(`The ${productName} stack, to delete in the CloudFormation console once the cleanup finishes.`),
}).openapi('DisconnectSummary');
type Summary=z.infer<typeof DisconnectSummary>;
const stackConsoleUrl=(stackId:string)=>`https://us-east-2.console.aws.amazon.com/cloudformation/home?region=us-east-2#/stacks/stackinfo?stackId=${encodeURIComponent(stackId)}`;
async function disconnectSummary(db:DbExecutor,c:V5Connection):Promise<Summary> {
  const rows=(await db.execute<{name:string;region:string;claim_scope:string;ses:CandidateIdentity|null}>(sql`SELECT dc.name,b.region,dc.claim_scope,dc.identity->'ses' AS ses FROM domain_claims dc
    JOIN domain_sending_bindings b ON b.workspace_id=dc.workspace_id AND b.name=dc.name AND b.connection_id=dc.connection_id
    WHERE dc.workspace_id=${c.workspace_id} AND dc.connection_id=${c.id} ORDER BY dc.name,b.region LIMIT 500`)).rows;
  const retained=rows.map(d=>{
    // Imported identities (claim_scope 'account') were the customer's before; only those Nightmail created list records.
    const created=d.claim_scope!=='account',dkim=d.ses?.DkimAttributes,zone=dkim?.SigningHostedZone,mailFrom=d.ses?.MailFromAttributes?.MailFromDomain;
    const records:z.infer<typeof DnsRecord>[]=!created?[]:[
      ...(zone && dkim?.SigningAttributesOrigin!=='EXTERNAL'?(dkim?.Tokens??[]).map(token=>({type:'CNAME' as const,name:`${token}._domainkey.${d.name}`,value:`${token}.${zone}`})):[]),
      ...(mailFrom?[{type:'MX' as const,name:mailFrom,value:`feedback-smtp.${d.region}.amazonses.com`,priority:10},{type:'TXT' as const,name:mailFrom,value:'v=spf1 include:amazonses.com ~all'}]:[])];
    return {domain:d.name,region:d.region,regionLabel:regionLabels[d.region]??d.region,createdByNightmail:created,records};
  });
  return {retained,leftBehind:[],stack:c.stack_id && c.stack_name && !c.stack_deleted_at?{name:c.stack_name,consoleUrl:stackConsoleUrl(c.stack_id)}:null};
}
const Cleanup=z.object({operationId:z.string(),lastError:z.object({region:z.string().nullable(),code:z.string()}).nullable(),remaining:z.array(z.object({region:z.string(),resources:Region.shape.resources})),retain:z.array(z.string()),summary:DisconnectSummary.nullable()});
export const InventoryFields={scan:ScanView.optional(),candidates:z.array(Candidate).optional(),cleanup:Cleanup.optional()};
export async function statuses(db:DbExecutor,cid:string) {
  const rows=(await db.execute<ScanRow & {pending:z.infer<typeof Pending>[];failed:z.infer<typeof FailedIntent>[]}>(sql`SELECT r.*,i.pending,i.failed FROM provider_connection_regions r CROSS JOIN LATERAL (SELECT
    coalesce(jsonb_agg(jsonb_build_object('domain',i.name,'importing',i.importing,'error',j.last_error) ORDER BY i.name) FILTER(WHERE i.closed_reason IS NULL),'[]') AS pending,
    coalesce(jsonb_agg(jsonb_build_object('domain',i.name,'importing',i.importing,'error',i.closed_reason) ORDER BY i.name) FILTER(WHERE i.closed_reason IS NOT NULL),'[]') AS failed
    FROM byo_domain_intents i LEFT JOIN jobs j ON j.id='byo.bind:'||i.id WHERE i.connection_id=r.connection_id AND i.region=r.region) i WHERE r.connection_id=${cid} ORDER BY r.region`)).rows;
  return rows.map(s=>({region:s.region,regionLabel:regionLabels[s.region]!,scanState:s.scan_state,scanError:s.scan_error,sendingState:s.sending_state,receivingState:s.receiving_state,error:s.provision_error,facts:s.scan_facts,resources:s.ownership_journal.map(({kind,resource,target,state})=>({kind,resource,target,state})),pending:s.pending,failedIntents:s.failed}));
}
async function candidates(db:DbExecutor,c:V5Connection) {
  const rows=(await db.execute<{name:string;region:string;identity:CandidateIdentity;complete:boolean;sandbox:boolean|null;overlap:boolean;bound:boolean}>(sql`SELECT i.name,i.region,i.identity,(r.scan_state='ready_to_import') AS complete,NOT (r.scan_facts->>'production')::boolean AS sandbox,exclusive_domain_overlap(${c.workspace_id},i.name) AS overlap,
    EXISTS(SELECT FROM domain_sending_bindings b WHERE b.workspace_id=${c.workspace_id} AND b.name=i.name) AS bound
    FROM byo_candidates i JOIN provider_connection_regions r USING(connection_id,region) WHERE i.connection_id=${c.id} AND i.revision=${c.inventory_revision} AND i.revision=r.scan_revision ORDER BY i.name,i.region`)).rows;
  return rows.map(d=>{
    const status=!d.complete?'incomplete':d.bound?'already_bound':d.overlap?'overlap':!d.identity.VerifiedForSendingStatus || d.identity.VerificationStatus!=='SUCCESS'?'not_verified':d.identity.DkimAttributes?.SigningEnabled && d.identity.DkimAttributes.Status==='SUCCESS'?'verified':'signing_pending';
    return {id:candidateId(d.region,d.name),domain:d.name,region:d.region,regionLabel:regionLabels[d.region]!,status,selectable:status==='verified'||status==='signing_pending',sandbox:d.sandbox,overlap:d.overlap,defaultConfigurationSet:d.identity.ConfigurationSetName??null,dkimStatus:d.identity.DkimAttributes?.Status??null,signingOrigin:d.identity.DkimAttributes?.SigningAttributesOrigin??null,mailFromDomain:d.identity.MailFromAttributes?.MailFromDomain??null} satisfies z.infer<typeof Candidate>;
  });
}
export async function inventory(db:DbExecutor,c:V5Connection) {
  const regions=await statuses(db,c.id),list=await candidates(db,c),checked=regions.filter(r=>r.scanState!=='scanning').length;
  const proof=c.aws_account_id?null:(await db.execute<{last_error:string|null}>(sql`SELECT last_error FROM jobs WHERE id=${proofId(c)}`)).rows[0]?.last_error??null;
  const state=!c.aws_account_id?(c.state==='failed'?'failed':'awaiting_role'):checked<Object.keys(regionLabels).length?'scanning':regions.every(s=>s.scanError)?'failed':regions.some(s=>s.scanError)?'partial':'ready_to_import';
  const evidence=list.length>0 || regions.some(({facts:f})=>(f.sentLast24Hours??0)>0 || Object.keys(f.configurationSets??{}).length>0 || !!f.receiving?.rules.length);
  const scan={revision:c.inventory_revision,cursor:{checked,total:Object.keys(regionLabels).length},state,error:proof,regions,alreadySendsEmail:evidence?true:state==='ready_to_import'?false:null} satisfies z.infer<typeof ScanView>;
  const cleanup=c.state==='disconnecting'?{operationId:disconnectId(c),lastError:c.disconnect_error,remaining:regions.map(r=>({region:r.region,resources:r.resources.filter(e=>e.kind!=='identity')})).filter(r=>r.resources.length),retain:['SES identities','DNS records','mailbox data'],summary:c.disconnect_summary??null}:undefined;
  return {candidates:list,scan,cleanup};
}

export const Imports=z.object({revision:z.number().int().positive(),candidateIds:z.array(z.string().min(1).max(300)).min(1).max(100),confirm:z.literal(true)}).strict();
export const Accepted=z.object({operationId:z.string(),regions:z.array(z.string())});
type Intent={id:string;region:string;name:string;importing:boolean};
async function saveIntent(db:DbExecutor,c:V5Connection,region:string,name:string,importing:boolean) {
  const row=(await db.execute<{sending_state:string;scan_state:string;production:boolean|null;bound:string|null;imported:boolean|null}>(sql`SELECT r.sending_state,r.scan_state,(r.scan_facts->>'production')::boolean AS production,b.region AS bound,(dc.identity @> '{"imported":true}') AS imported FROM provider_connection_regions r
    LEFT JOIN domain_sending_bindings b ON b.workspace_id=${c.workspace_id} AND b.name=${name} LEFT JOIN domain_claims dc ON dc.workspace_id=b.workspace_id AND dc.name=b.name
    WHERE r.connection_id=${c.id} AND r.region=${region} FOR SHARE OF r`)).rows[0];
  if (!row || row.sending_state==='disabled' || row.scan_state!=='ready_to_import' && (importing || row.sending_state!=='ready')) throw stale();
  // Mail starts only where AWS granted production access: the SES sandbox delivers to verified addresses alone.
  if (row.production!==true) throw conflict('PRODUCTION_ACCESS_REQUIRED',`${regionLabels[region]} is in the SES sandbox, which delivers only to verified addresses. Request production access for it first.`);
  if (row.bound) {
    if (row.bound!==region || importing && !row.imported) throw conflict('DOMAIN_REGION_CONFLICT','This domain already has a sending binding.');
    return;
  }
  if ((await db.execute(sql`SELECT FROM (SELECT exclusive_domain_overlap(${c.workspace_id},${name}) AS overlap) e WHERE overlap`)).rowCount) throw domainClaimed();
  const intent=(await db.execute<Intent>(sql`INSERT INTO byo_domain_intents AS i(id,connection_id,region,name,importing) VALUES(${id('dom')},${c.id},${region},${name},${importing})
    ON CONFLICT(connection_id,name) DO UPDATE SET id=CASE WHEN i.closed_reason IS NULL THEN i.id ELSE excluded.id END,region=excluded.region,importing=excluded.importing,closed_reason=NULL
    WHERE i.closed_reason IS NOT NULL OR (i.region=excluded.region AND i.importing=excluded.importing) RETURNING *`)).rows[0];
  if (!intent) throw conflict('DOMAIN_REGION_CONFLICT','Only one sending region may be selected for a domain.');
  // The identities live in the customer's own SES account, so no workspace total applies: only the 10 unproven domains,
  // counting this intent.
  const cap=(await db.execute<{unproven:number}>(sql`SELECT
    (SELECT count(*) FROM domain_claims WHERE workspace_id=${c.workspace_id} AND NOT ever_proven)+(SELECT count(*) FROM byo_domain_intents WHERE connection_id=${c.id} AND closed_reason IS NULL AND NOT importing) AS unproven`)).rows[0]!;
  if (!importing && Number(cap.unproven)>10) throw domainLimitError(0,null);
  if (row.sending_state==='ready') await queueBinding(db,c,intent);
  else await job(db,c,'byo.provision',regionJobId(c,region),{region});
}
const queueBinding=(db:DbExecutor,c:V5Connection,i:Intent)=>job(db,c,'byo.bind','byo.bind:'+i.id,{intent:i.id,region:i.region});
export async function selectImports(r:Runtime,wid:string,input:z.infer<typeof Imports>,key?:string) {
  const c=await requiredV5(r,wid);
  const request=JSON.stringify([c.id,input.revision,[...input.candidateIds].sort()]),op=receipt<Op>(c,'imports',key,request),prior=await op.read(r.db);if (prior) return prior;
  if (c.inventory_revision!==input.revision) throw stale();
  const rows=await candidates(r.db,c), found=new Map(rows.map(v=>[v.id,v])), names=new Set<string>(), groups=new Map<string,string[]>();
  for (const key of input.candidateIds) {
    const v=found.get(key);if (!v || !v.selectable && v.status!=='already_bound') throw stale();
    if (names.has(v.domain)) throw conflict('DUPLICATE_DOMAIN_SELECTION','Select only one region for each domain.');
    names.add(v.domain);groups.set(v.region,[...(groups.get(v.region)??[]),v.domain]);
  }
  // No DB locks across network I/O. The accepting transaction rechecks both revision
  // and regional completeness; a rescan racing these reads invalidates the request.
  for (const [region,domains] of groups) try { await readSelectedDomains(await scoped(r,c,region,'scan'),region,domains); } catch(e) { if (e instanceof ModuleLoadError) throw e; throw awsError(e); }
  return r.db.transaction(async db=>{
    await getRegionSettings(db,wid,'update');
    const locked=usable(await connection(db,wid,true)),replay=await op.read(db);if (replay) return replay;
    if (locked.id!==c.id || locked.inventory_revision!==input.revision) throw stale();
    for (const [region,domains] of groups) for (const name of domains) await saveIntent(db,c,region,name,true);
    return op.save(db,{operationId:'byo.import:'+hash(request),regions:[...groups.keys()].sort()});
  });
}

// Existing v4/Hosted connections continue to use the synchronous domain API. For
// v5 this returns a durable operation, even if the workspace has no ready region yet.
export async function newRegionalDomain(r:Runtime,wid:string,name:string,owner:boolean,override?:string,key?:string) {
  const c=await connection(r.db,wid);if (!c) return null;
  if (!owner) throw denied('PERMISSION_DENIED','Use an owner or admin dashboard session to enable a regional domain.',{ permission: 'configuration', level: 'write', credential: 'dashboard', person: 'admin' });
  await writable(r,wid);if (!await claimNameAllowed(name,r.config)) throw new ApiError(422,'DOMAIN_NOT_ALLOWED','A public suffix or reserved domain cannot be claimed.','name');
  return r.db.transaction(async db=>{
    await getRegionSettings(db,wid,'update');if (usable(await connection(db,wid,true)).id!==c.id) throw stale();
    const op=receipt<Op>(c,'domain',key,JSON.stringify([name,override])),prior=await op.read(db);if(prior)return prior;
    const current=(await db.execute<{region:string}>(sql`SELECT region FROM domain_sending_bindings WHERE workspace_id=${wid} AND name=${name} UNION ALL SELECT region FROM byo_domain_intents WHERE connection_id=${c.id} AND name=${name} AND closed_reason IS NULL LIMIT 1`)).rows[0];
    const first=(await db.execute<{region:string}>(sql`SELECT region FROM provider_connection_regions WHERE connection_id=${c.id} AND sending_state='ready' ORDER BY ready_at,region LIMIT 1`)).rows[0];
    const region=override??current?.region??first?.region??'us-east-2';
    if (!Object.hasOwn(regionLabels,region)) throw new ApiError(422,'INVALID_REGION','Choose a commercial SES sending region.','region');
    await saveIntent(db,c,region,name,false);
    return op.save(db,{operationId:'byo.domain:'+hash(JSON.stringify([c.id,region,name])),regions:[region]});
  });
}

const provision=runV5(async(r,c,p,attempt)=>{
  await Promise.all([loadStsSdk(), loadSetupSdk()]);
  const region=String(p.region),ref={connectionId:c.id,region};
  const task=regionJobId(c,region), active=sql`EXISTS(SELECT FROM jobs WHERE id=${task} AND status='running' AND attempts=${attempt} AND lease_until>clock_timestamp() AND payload->>'run'=${p.run})`;
  const target=sql`connection_id=${c.id} AND region=${region} AND NOT legacy`;
  const row=(await r.db.execute<{generation:string;ownership_journal:JournalEntry[]}>(sql`SELECT generation,ownership_journal FROM provider_connection_regions WHERE ${target} AND ${active} AND sending_state NOT IN ('ready','disabled')`)).rows[0];
  if (!row) return;
  let gen=Number(p.generation??0);
  if (!gen || !(await r.db.execute(sql`UPDATE provider_connection_regions SET lease_until=clock_timestamp()+interval '4 minutes' WHERE ${target} AND ${active} AND sending_state='provisioning' AND generation=${gen} AND lease_until>clock_timestamp()`)).rowCount) {
    const accepted=sql`EXISTS(SELECT FROM byo_domain_intents i WHERE i.connection_id=${c.id} AND i.region=${region} AND i.closed_reason IS NULL)`;
    const claimed=(await r.db.execute(acquireRegionProvisioning(ref,sql`${active} AND ${accepted}`,accepted))).rows[0];
    if (!claimed) throw defer(15_000,p);
    gen=Number(claimed.generation);
  }
  const owned=sql`${target} AND ${active} AND sending_state='provisioning' AND generation=${gen} AND lease_until>clock_timestamp()`;
  const fenced=(count:number|null)=>{if (!count) throw conflict('PROVISION_LEASE_LOST','Regional setup is owned by a newer generation.');};
  const journal=(await r.db.execute<{ownership_journal:JournalEntry[]}>(sql`SELECT ownership_journal FROM provider_connection_regions WHERE ${owned}`)).rows[0];
  if (!journal) return;
  try {
    if (!journal.ownership_journal.length) {
      const pending=(await r.db.execute<Intent>(sql`SELECT * FROM byo_domain_intents WHERE connection_id=${c.id} AND region=${region} AND closed_reason IS NULL`)).rows;
      if (!pending.length) throw conflict('NO_SELECTED_DOMAINS','No domains were selected for this region.');
      const imports=new Map(pending.filter(i=>i.importing).map(i=>[i.name,i.id]));
      if (imports.size) {
        let retired=false;
        const verified=await readSelectedDomains(await scoped(r,c,region,'scan'),region,[...imports.keys()],async name=>{
          await r.db.transaction(async db=>{
            await connection(db,c.workspace_id,true); // Serialize last-intent retirement with accepting a new selection.
            fenced((await db.execute(sql`UPDATE byo_domain_intents SET closed_reason='CANDIDATE_NO_LONGER_VERIFIED' WHERE id=${imports.get(name)!} AND closed_reason IS NULL
              AND EXISTS(SELECT FROM provider_connection_regions WHERE ${owned})`)).rowCount);
            if ((await db.execute(sql`UPDATE provider_connection_regions SET sending_state='unprovisioned',lease_until=NULL,provision_error=NULL WHERE ${owned}
              AND NOT EXISTS(SELECT FROM byo_domain_intents WHERE connection_id=${c.id} AND region=${region} AND closed_reason IS NULL)`)).rowCount) {
              // Make the queue row reusable before releasing the connection lock; the
              // runner's settlement is fenced by run and cannot overwrite its successor.
              fenced((await db.execute(sql`UPDATE jobs SET status='completed',lease_until=NULL,last_error=NULL WHERE id=${task} AND status='running' AND attempts=${attempt} AND payload->>'run'=${p.run}`)).rowCount);
              retired=true;
            }
          });
        });
        if (retired) return;
        if (!verified.size && imports.size===pending.length) throw defer(1000,{...p,generation:gen}); // Recheck selections added during the SES reads.
      }
    }
    const result=await provisionJournaledFeedback(await scoped(r,c,region,'provision'),region,c.id,journal.ownership_journal,
      async()=>fenced((await r.db.execute(sql`SELECT FROM provider_connection_regions WHERE ${owned}`)).rowCount),
      async entry=>fenced((await r.db.execute(sql`UPDATE provider_connection_regions SET ownership_journal=(SELECT coalesce(jsonb_agg(e),'[]') FROM jsonb_array_elements(ownership_journal) e WHERE NOT(e->>'kind'=${entry.kind} AND e->>'resource'=${entry.resource}))||${JSON.stringify([entry])}::jsonb WHERE ${owned}`)).rowCount),
      async arn=>fenced((await r.db.execute(sql`UPDATE provider_connection_regions SET feedback_topic_arn=${arn} WHERE ${owned} AND (feedback_topic_arn IS NULL OR feedback_topic_arn=${arn})`)).rowCount));
    if (result.verified) {
      const published=await r.db.transaction(async db=>{
        await getRegionSettings(db,c.workspace_id,'update');await connection(db,c.workspace_id,true);
        if (!(await db.execute(sql`SELECT FROM provider_connection_regions WHERE ${owned} FOR UPDATE`)).rowCount) return false;
        if (!(await db.execute(finishRegionProvisioning(ref,gen,result.topic))).rowCount) return false;
        await db.execute(sql`UPDATE provider_connection_regions SET ready_at=coalesce(ready_at,clock_timestamp()),provision_error=NULL WHERE ${target}`);
        await db.execute(sql`UPDATE ses_installation_settings SET installation_id=${c.id},default_region=(SELECT region FROM provider_connection_regions WHERE connection_id=${c.id} AND sending_state='ready' ORDER BY ready_at,region LIMIT 1),
          enabled_regions=(SELECT jsonb_agg(region ORDER BY ready_at,region) FROM provider_connection_regions WHERE connection_id=${c.id} AND sending_state='ready') WHERE workspace_id=${c.workspace_id}`);
        const pending=(await db.execute<Intent>(sql`SELECT * FROM byo_domain_intents WHERE connection_id=${c.id} AND region=${region} AND closed_reason IS NULL`)).rows;
        for (const i of pending) await queueBinding(db,c,i);
        return true;
      });
      if (published) return;
    }
    await r.db.execute(sql`UPDATE provider_connection_regions SET provision_error='SNS_CONFIRMATION_PENDING' WHERE ${owned}`);
    throw defer(15_000,{...p,generation:gen});
  } catch(e) {
    if (e instanceof JobDeferred || e instanceof ModuleLoadError) throw e;
    const err=awsError(e);
    if (err.retryable) {
      // Keep the journaled topic eligible for signed confirmations during backoff,
      // including when SNS accepted Subscribe but its response never reached us.
      await r.db.execute(sql`UPDATE provider_connection_regions SET provision_error=${err.code} WHERE ${owned}`);
      throw defer(30_000,{...p,generation:gen});
    }
    await r.db.execute(sql`UPDATE provider_connection_regions SET sending_state='failed',lease_until=NULL,provision_error=${err.code} WHERE ${owned}`);
    throw err;
  }
});

async function bindIntent(r:Runtime,c:V5Connection,p:Record<string,unknown>) {
  const guard=sql`i.connection_id=${c.id} AND i.id=${p.intent} AND i.region=${p.region} AND i.closed_reason IS NULL AND cr.sending_state='ready' AND cr.confirmed_topic_arn=cr.feedback_topic_arn AND cr.confirmed_generation=cr.generation`;
  const select=sql`SELECT i.* FROM byo_domain_intents i JOIN provider_connection_regions cr USING(connection_id,region) WHERE ${guard}`;
  const i=(await r.db.execute<Intent>(select)).rows[0];if (!i) return;
  let ses:CandidateIdentity|undefined;
  if (i.importing) try { ses=(await readSelectedDomains(await scoped(r,c,i.region,'scan'),i.region,[i.name])).get(i.name); } catch(e) { if (e instanceof ModuleLoadError) throw e; throw awsError(e); }
  await r.db.transaction(async db=>{
    await getRegionSettings(db,c.workspace_id,'update');await connection(db,c.workspace_id,true);
    if (!(await db.execute(sql`${select} FOR UPDATE OF i FOR SHARE OF cr`)).rowCount) return;
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(substring(${i.name} FROM '[^.]+\\.[^.]+$'),84912))`);
    if ((await db.execute(sql`SELECT WHERE exclusive_domain_overlap(${c.workspace_id},${i.name})`)).rowCount) throw domainClaimed();
    const claim=(await db.execute<{id:string|null;token:string;error_code:string|null}>(sql`SELECT * FROM reserve_regional_claim(${c.workspace_id},${i.name},${i.region},${i.id},${i.importing?c.id:null})`)).rows[0];
    if (!claim?.id) throw conflict(claim?.error_code??'DOMAIN_CLAIMED','The requested regional binding is no longer available.');
    if (ses) {
      await db.execute(verifyImportedClaims(c.id,[{name:i.name,ses}]));
      if (ses.DkimAttributes?.Status!=='SUCCESS' || !ses.DkimAttributes.SigningEnabled) await db.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload,available_at) VALUES(${'domain.verify:'+claim.token},'domain.verify',${c.workspace_id},${JSON.stringify({domainId:claim.id,token:claim.token})}::jsonb,now()+interval '1 minute') ON CONFLICT DO NOTHING`);
    }
    await db.execute(sql`DELETE FROM byo_domain_intents WHERE connection_id=${c.id} AND id=${i.id}`);
  });
}
const bind=runV5(async(r,c,p,attempt)=>{
  try {await bindIntent(r,c,p);} catch(e) {
    if (e instanceof ModuleLoadError) throw e;
    // Preserve transient failures for retry. Closing only this attempt's intent
    // frees the name and capacity; a new selection gets a distinct ID and job.
    if (e instanceof ApiError && !e.retryable) await r.db.execute(sql`UPDATE byo_domain_intents i SET closed_reason=${e.code}
      FROM jobs j WHERE i.connection_id=${c.id} AND i.id=${p.intent} AND i.closed_reason IS NULL AND j.id='byo.bind:'||i.id AND j.workspace_id=${c.workspace_id}
        AND j.status='running' AND j.attempts=${attempt} AND j.payload->>'run'=${p.run}`);
    throw e;
  }
});
const disconnectId=(c:V5Connection)=>'byo.disconnect:'+c.id;
// Setup work for one connection. Stack requests, health checks and the disconnect itself aren't setup: they never
// create anything in the account.
const setupJobs=(c:V5Connection)=>sql`workspace_id=${c.workspace_id} AND ((type LIKE 'byo.%' AND type NOT IN ('byo.stack','byo.health','byo.disconnect') AND payload->>'connectionId'=${c.id}) OR type IN ('domain.verify','domain.mx','mailbox.reconcile'))`;
// Stops sending from the connection and records what its disconnect keeps. A forced fence (the stack is being deleted, so
// the role is about to go) doesn't wait for outstanding mail: the dispatcher cancels mail still queued for a disabled
// region, and the cleanup waits for running setup jobs and mail mid-attempt before it finishes.
async function fence(db:DbExecutor,c:V5Connection,forced:boolean) {
  // A stack being deleted has nothing left to delete.
  const summary=await disconnectSummary(db,forced?{...c,stack_deleted_at:c.stack_deleted_at??new Date().toISOString()}:c);
  await db.execute(sql`UPDATE jobs SET status='completed',lease_until=NULL,last_error=NULL WHERE ${setupJobs(c)} AND status='pending'`);
  await db.execute(sql`UPDATE provider_connections SET state='disconnecting',disconnect_summary=${JSON.stringify(summary)}::jsonb${forced?sql`,stack_deleted_at=coalesce(stack_deleted_at,now())`:sql``} WHERE id=${c.id}`);
  await db.execute(sql`UPDATE provider_connection_regions SET sending_state='disabled',generation=generation+1,lease_until=NULL WHERE connection_id=${c.id}`);
  await job(db,c,'byo.disconnect',disconnectId(c));
  return summary;
}
export async function disconnectV5(r:Runtime,wid:string,connectionId:string,audit:(db:DbExecutor,c:V5Connection)=>Promise<unknown>) {
  await writable(r,wid);
  return r.db.transaction(async db=>{
    await lockSendScope(db,wid,{settings:'update'});
    const c=await connection(db,wid,true);if (!c || c.id!==connectionId) throw stale();
    if (c.state==='disconnecting') { await job(db,c,'byo.disconnect',disconnectId(c));return {operationId:disconnectId(c),summary:c.disconnect_summary??await disconnectSummary(db,c)}; }
    const busy=()=>conflict('CONNECTION_IN_USE','Finish outstanding mail, campaigns and running setup jobs before disconnecting.');
    if ((await db.execute(sql`SELECT FROM sending_emails WHERE workspace_id=${wid} AND status IN ('queued','attempting','acceptance_unknown') LIMIT 1`)).rowCount ||
        (await db.execute(sql`SELECT FROM sending_campaigns c WHERE workspace_id=${wid} AND ${campaignReserved()} LIMIT 1`)).rowCount) throw busy();
    if ((await db.execute(sql`SELECT FROM provider_connection_regions WHERE connection_id=${c.id} AND (legacy OR receiving_state<>'off' OR inbound_topic_arn IS NOT NULL) LIMIT 1`)).rowCount) throw conflict('REGIONAL_DISCONNECT_REQUIRED','Receiving resources require separate reviewed cleanup.');
    const jobs=(await db.execute<{status:string}>(sql`SELECT status FROM jobs WHERE ${setupJobs(c)} AND status IN ('pending','running') ORDER BY id FOR UPDATE`)).rows;
    if (jobs.some(j=>j.status==='running')) throw busy();
    const summary=await fence(db,c,false);await audit(db,c);
    return {operationId:disconnectId(c),summary};
  });
}

const disconnect:JobHandler=retryDatabaseFailures(async(r,p,j)=>{
  if (!await byoEnabled(r,j.workspaceId)) throw defer(300_000);
  await Promise.all([loadStsSdk(), loadSetupSdk()]);
  let region:string|null=null;
  const ticket=sql`id=${j.id} AND workspace_id=${j.workspaceId} AND status='running' AND attempts=${j.attempts} AND payload->>'run'=${p.run}`;
  try {
    const more=await r.db.transaction(async db=>{
      await getRegionSettings(db,j.workspaceId,'update');const c=await connection(db,j.workspaceId,true);
      if (!c || c.id!==p.connectionId || c.state!=='disconnecting') return false;
      // Fence the worker through one bounded AWS removal and its checkpoint. Losing
      // the response leaves the old journal; a retry proves absence or checks ownership anew.
      if (!(await db.execute(sql`SELECT FROM jobs WHERE ${ticket} AND lease_until>clock_timestamp() FOR UPDATE`)).rowCount) return false;
      // After a forced fence, setup still running and mail still queued or mid-attempt settle before anything is removed:
      // setup could create a resource after its region was cleaned, and the dispatcher cancels queued mail and marks an
      // interrupted attempt unknown. Feedback SES sends later for mail already accepted is lost with the topic.
      if ((await db.execute(sql`SELECT FROM jobs WHERE ${setupJobs(c)} AND status='running' AND lease_until>clock_timestamp() LIMIT 1`)).rowCount ||
          (await db.execute(sql`SELECT FROM sending_emails WHERE workspace_id=${c.workspace_id} AND status IN ('queued','attempting') LIMIT 1`)).rowCount) return 'wait';
      const rr=(await db.execute<{region:string;ownership_journal:JournalEntry[];feedback_topic_arn:string|null}>(sql`SELECT region,ownership_journal,feedback_topic_arn FROM provider_connection_regions WHERE connection_id=${c.id} AND
        (feedback_topic_arn IS NOT NULL OR EXISTS(SELECT FROM jsonb_array_elements(ownership_journal) e WHERE e->>'kind' IS DISTINCT FROM 'identity')) ORDER BY region LIMIT 1 FOR UPDATE`)).rows[0];
      if (!rr) {
        const left=c.disconnect_summary?.leftBehind??[];
        if (left.length) await recordAudit(db,systemContext('job'),{action:'connection.cleanup',workspaceId:c.workspace_id,target:{type:'connection',id:c.id},after:{leftBehind:left.slice(0,50)},internal:false});
        await db.execute(sql`WITH ${releaseConnectionClaims(c.workspace_id,sql`SELECT ${c.id}::text AS id`)} SELECT 1`);
        await db.execute(sql`DELETE FROM provider_connections WHERE id=${c.id} AND state='disconnecting'`);return false;
      }
      region=rr.region;
      let remaining:JournalEntry[];
      try { remaining=await removeByoFeedbackResource(await scoped(r,c,region,'cleanup'),region,c.id,rr.ownership_journal,rr.feedback_topic_arn); }
      catch(e) {
        // Once the stack is deleted (stack_deleted_at), what the role can't remove now it never will, and what was
        // changed in AWS isn't removed at all: list it in the summary and go on. Otherwise the owner fixes access and retries.
        const code=awsError(e).code;
        if (!c.stack_deleted_at || (code!=='AWS_ACCESS_DENIED' && code!=='BYO_CLEANUP_DRIFT')) throw e;
        const entries=rr.ownership_journal.filter(e=>e.kind!=='identity');
        const left=[...entries.map(e=>({region:rr.region,kind:e.kind,resource:e.resource})),...(rr.feedback_topic_arn && !entries.some(e=>e.resource===rr.feedback_topic_arn)?[{region:rr.region,kind:'topic',resource:rr.feedback_topic_arn}]:[])];
        await db.execute(sql`UPDATE provider_connections SET disconnect_summary=jsonb_set(coalesce(disconnect_summary,'{"retained":[],"leftBehind":[],"stack":null}'::jsonb),'{leftBehind}',coalesce(disconnect_summary->'leftBehind','[]'::jsonb)||${JSON.stringify(left)}::jsonb) WHERE id=${c.id}`);
        log('warn',{code:'BYO_CLEANUP_LEFT',connectionId:c.id,region:rr.region,reason:code,resources:left.length});
        remaining=rr.ownership_journal.filter(e=>e.kind==='identity');
      }
      await db.execute(sql`UPDATE provider_connection_regions SET ownership_journal=${JSON.stringify(remaining)}::jsonb,feedback_topic_arn=${remaining.some(e=>e.kind==='topic')?rr.feedback_topic_arn:null} WHERE connection_id=${c.id} AND region=${region}`);
      await db.execute(sql`UPDATE provider_connections SET disconnect_error=NULL WHERE id=${c.id}`);return true;
    });
    if (more) throw defer(more==='wait'?5000:1000,p);
  } catch(e) {
    if (e instanceof JobDeferred || e instanceof ModuleLoadError) throw e;
    const err=awsError(e);await r.db.execute(sql`UPDATE provider_connections SET disconnect_error=${JSON.stringify({region,code:err.code})}::jsonb WHERE id=${p.connectionId} AND state='disconnecting' AND EXISTS(SELECT FROM jobs WHERE ${ticket})`);throw err;
  }
});
// Production access. A new SES account sends only to verified addresses until AWS grants production access, region by
// region. The role (template 6.0's AccountRequests, on by default) lets Nightmail file that request for the customer,
// once, with the details they confirm. PutAccountDetails could also turn production access off and overwrite an
// account's existing details, so it is never called once access is granted or while AWS is reviewing a request.
export const ProductionAccess=z.object({websiteUrl:z.url({protocol:/^https?$/}).max(1000).openapi({example:'https://example.com'}),useCase:z.string().trim().min(40).max(5000).describe('How the account sends mail and to whom, for AWS\'s review.').openapi({example:'We send receipts and account notices to our own customers, who signed up for them.'}),mailType:z.enum(['TRANSACTIONAL','MARKETING']),confirm:z.literal(true)}).strict().openapi('ProductionAccessRequest');
export const ProductionAccessState=z.object({region:z.string(),production:z.boolean(),review:z.object({status:z.string(),caseId:z.string().nullable()}).nullable()}).openapi('ProductionAccessState');
export async function requestProductionAccess(r:Runtime,wid:string,region:string,input:z.infer<typeof ProductionAccess>,audit:(db:DbExecutor,connectionId:string)=>Promise<void>) {
  const c=await requiredV5(r,wid);
  if (!c.aws_account_id) throw conflict('CONNECTION_REQUIRED','Connect the AWS account first.');
  if (!(region in regionLabels) || !(await r.db.execute(sql`SELECT FROM provider_connection_regions WHERE connection_id=${c.id} AND region=${region}`)).rowCount) throw new ApiError(422,'INVALID_REGION','Choose a commercial SES sending region.','region');
  await Promise.all([loadStsSdk(),loadSetupSdk()]);
  const aws=await assume(r,region,c.role_arn!,c.external_id,false,byoSessionPolicy('account',{region,account:c.aws_account_id,connectionId:c.id}),{connectionId:c.id,purpose:'account'});
  const [{SESv2Client,GetAccountCommand,PutAccountDetailsCommand},{FetchHttpHandler}]=await Promise.all([import('@aws-sdk/client-sesv2'),import('@smithy/fetch-http-handler')]);
  const client=new SESv2Client({region,credentials:aws,ignoreConfiguredEndpointUrls:true,maxAttempts:2,requestHandler:new FetchHttpHandler({requestTimeout:8000})});
  const save=(production:boolean,review:{status:string;caseId:string|null}|null)=>r.db.execute(sql`UPDATE provider_connection_regions SET scan_facts=scan_facts||${JSON.stringify({production,review})}::jsonb WHERE connection_id=${c.id} AND region=${region}`);
  try {
    const now=await client.send(new GetAccountCommand({})),current=now.Details?.ReviewDetails;
    const review=current?{status:current.Status??'UNKNOWN',caseId:current.CaseId??null}:null;
    if (now.ProductionAccessEnabled) { await save(true,review);throw conflict('PRODUCTION_ACCESS_GRANTED',`${regionLabels[region]} already has production access. Nothing was changed.`); }
    if (review?.status==='PENDING') { await save(false,review);throw conflict('PRODUCTION_ACCESS_PENDING',`AWS is already reviewing a request for ${regionLabels[region]}${review.caseId?` (case ${review.caseId})`:''}.`); }
    // The audit row is written before AWS is asked, so a request never goes unrecorded.
    await r.db.transaction(async db=>{
      await audit(db,c.id);
      await client.send(new PutAccountDetailsCommand({ProductionAccessEnabled:true,MailType:input.mailType,WebsiteURL:input.websiteUrl,ContactLanguage:'EN',UseCaseDescription:input.useCase}));
    });
    const after=(await client.send(new GetAccountCommand({}))).Details?.ReviewDetails;
    const state={status:after?.Status??'PENDING',caseId:after?.CaseId??null};
    await save(false,state);
    return {region,production:false,review:state};
  } catch(e) {
    if (e instanceof ApiError) throw e;
    if (awsError(e).code==='AWS_ACCESS_DENIED') throw conflict('ACCOUNT_REQUESTS_OFF',`The ${productName} stack was created with account requests turned off. Request production access for ${regionLabels[region]} in the SES console instead.`);
    throw awsError(e);
  } finally { client.destroy(); }
}

// Stack requests. A published role template (api/byo-templates/) has a Custom::NightmailConnection resource:
// CloudFormation publishes a request to the platform's setup topic when the customer's stack is created, updated or
// deleted, and waits for Nightmail's answer at a presigned URL. Anyone may publish to that topic, so a request proves
// nothing by itself. What needs no AWS call is refused before any work is queued, and the work a connection can queue
// is bounded. A request is then acted on only as the stack reports itself through the role: Create binds the stack
// that has this connection's name and parameters and is creating its Connection resource now; Delete counts only when
// that resource is being deleted, and AccessDenied says nothing about whether it is.
const stackArn=/^arn:aws:cloudformation:us-east-2:(\d{12}):stack\/([A-Za-z][A-Za-z0-9-]{0,127})\/[0-9a-f-]{36}$/;
const StackProps=z.object({ServiceToken:z.string().max(256).optional(),ConnectionId:z.string().regex(/^conn_[0-9a-f]{32}$/),RoleArn:z.string().max(256).optional(),TemplateVersion:z.string().max(16)});
// Only these fields are kept (unknown ones are dropped), each bounded, so a stored request stays small.
export const StackRequest=z.object({
  RequestType:z.enum(['Create','Update','Delete']),ResponseURL:z.string().url().max(4096),StackId:z.string().regex(stackArn),RequestId:z.string().min(1).max(200),
  ResourceType:z.literal('Custom::NightmailConnection'),LogicalResourceId:z.literal('Connection'),PhysicalResourceId:z.string().min(1).max(1024).optional(),
  ResourceProperties:StackProps,OldResourceProperties:StackProps.partial().optional(),
}).refine(v=>v.RequestType==='Create' || !!v.PhysicalResourceId);
type StackRequest=z.infer<typeof StackRequest>;
// Per connection: requests in flight, and requests in the last hour.
const STACK_IN_FLIGHT=3,STACK_PER_HOUR=20;
// The presigned S3 URL CloudFormation waits on in us-east-2 (the template asserts that region): nowhere else.
function stackResponseUrl(value:string) {
  const u=new URL(value);
  if (u.protocol!=='https:' || u.username || u.password || u.port || u.hash || !/^cloudformation-custom-resource-response-useast2\.s3(?:[.-]us-east-2)?\.amazonaws\.com$/.test(u.hostname)) throw new ApiError(400,'STACK_REQUEST_INVALID','The stack request has no CloudFormation response URL.');
  return u;
}
async function answerStack(req:StackRequest,Status:'SUCCESS'|'FAILED',Reason:string) {
  // Keep the physical ID CloudFormation already has: a new one would make it delete the old resource.
  const body=JSON.stringify({Status,Reason:Reason.slice(0,900),PhysicalResourceId:req.PhysicalResourceId??req.ResourceProperties.ConnectionId,StackId:req.StackId,RequestId:req.RequestId,LogicalResourceId:req.LogicalResourceId,NoEcho:false,Data:{}});
  // The URL is presigned without a content type, so send the bytes with none.
  const res=await fetch(stackResponseUrl(req.ResponseURL),{method:'PUT',body:new TextEncoder().encode(body),redirect:'manual',signal:AbortSignal.timeout(8000)});
  await res.body?.cancel();
  if (!res.ok) throw new ApiError(503,'STACK_RESPONSE_FAILED','CloudFormation did not accept the stack response.',undefined,true);
  log('info',{code:'BYO_STACK_ANSWERED',requestType:req.RequestType,status:Status});
}
const nobody=(req:StackRequest)=>req.RequestType==='Create'?answerStack(req,'FAILED',`${productName} has no connection waiting for this stack. Start again from Connect AWS in ${productName}.`):answerStack(req,'SUCCESS',`No ${productName} connection uses this stack.`);
// The checks that need no AWS call, before a request is queued and again when it runs: the answer to send now, or null
// to go on. A refused Create is also shown in setup, so the reason isn't only in the AWS console.
async function refusal(r:Runtime,c:V5Connection,req:StackRequest):Promise<(()=>Promise<void>)|null> {
  const [,account,name]=stackArn.exec(req.StackId)!,ours=c.stack_id===req.StackId;
  const fail=(reason:string)=>async()=>{if (req.RequestType==='Create') await r.db.execute(sql`UPDATE provider_connections SET stack_error=${reason} WHERE id=${c.id} AND aws_account_id IS NULL`);await answerStack(req,'FAILED',reason);};
  if (req.RequestType!=='Create') {
    // A rollback of an update that tried to move the stack names this connection again, and is answered as usual.
    if (!ours && req.RequestType==='Update' && req.OldResourceProperties?.ConnectionId && req.OldResourceProperties.ConnectionId!==req.ResourceProperties.ConnectionId) return fail(`A stack can't move to another ${productName} connection. Create a new stack from Connect AWS instead.`);
    // Nightmail's physical ID for the resource is the connection's ID: never act for another connection's.
    if (!ours || (req.PhysicalResourceId && /^conn_[0-9a-f]{32}$/.test(req.PhysicalResourceId) && req.PhysicalResourceId!==c.id)) return ()=>answerStack(req,'SUCCESS',`No ${productName} connection uses this stack.`);
    return null;
  }
  if (!r.config.byoV2 || !await byoEnabled(r,c.workspace_id)) return fail(`Bring your own AWS isn't turned on for this ${productName} workspace.`);
  if (account===requirePlatformAccount(r.config.platformAccount)) return fail(`${productName}'s own AWS account can't be connected. Sign in to your AWS account and use the Connect AWS link again.`);
  if (name!==c.stack_name) return fail(`Name the stack ${c.stack_name}, as the Connect AWS link does.`);
  if (c.state==='disconnecting') return fail(`This connection is being disconnected in ${productName}.`);
  if (c.aws_account_id && (c.aws_account_id!==account || (c.stack_id && !ours))) return fail(`This ${productName} connection already uses another stack. Start again from Connect AWS.`);
  if (c.requested_account && c.requested_account!==account) return fail(`You chose AWS account ${c.requested_account} in ${productName}, but this stack is in ${account}. Sign in to ${c.requested_account}, or start again from Connect AWS.`);
  return null;
}
/** One verified SNS notification from the setup topic: answers at once what needs no AWS call, else queues byo.stack. */
export async function stackNotification(r:Runtime,message:string) {
  let req:StackRequest;
  try { req=StackRequest.parse(JSON.parse(message)); stackResponseUrl(req.ResponseURL); } catch { throw new ApiError(400,'STACK_REQUEST_INVALID','Expected a Nightmail stack request.'); }
  const c=(await r.db.execute<V5Connection>(sql`SELECT * FROM provider_connections WHERE id=${req.ResourceProperties.ConnectionId} AND kind='byo' AND template_version='v5'`)).rows[0];
  if (!c) { await nobody(req);return false; }
  const answer=await refusal(r,c,req);
  if (answer) { await answer();return false; }
  // A role can take seconds to be usable everywhere; keep trying well inside the stack's 15-minute wait. The same request
  // delivered again is one job; past the limits a request is dropped (CloudFormation then times out on it).
  const jobId='byo.stack:'+hash(req.StackId+'\n'+req.RequestId),payload={connectionId:c.id,request:req,deadline:Date.now()+12*60_000,run:id('run')};
  const queued=!!(await r.db.execute(sql`INSERT INTO jobs(id,workspace_id,type,payload) SELECT ${jobId},${c.workspace_id},'byo.stack',${JSON.stringify(payload)}::jsonb
    FROM (SELECT count(*) FILTER (WHERE status IN ('pending','running')) AS open,count(*) AS recent FROM jobs WHERE workspace_id=${c.workspace_id} AND type='byo.stack' AND payload->>'connectionId'=${c.id}
      AND (status IN ('pending','running') OR created_at>now()-interval '1 hour')) n WHERE n.open<${STACK_IN_FLIGHT} AND n.recent<${STACK_PER_HOUR} ON CONFLICT(id) DO NOTHING`)).rowCount;
  if (!queued) log('warn',{code:'BYO_STACK_REQUEST_DROPPED',connectionId:c.id,requestType:req.RequestType});
  return queued;
}
const loadCloudFormation=lazyModule(()=>Promise.all([import('@aws-sdk/client-cloudformation'),import('@smithy/fetch-http-handler')]));
type OwnStack={stack:import('@aws-sdk/client-cloudformation').Stack;resource:import('@aws-sdk/client-cloudformation').StackResourceDetail|undefined};
/** The stack (by name or ID) and its Connection resource as they report themselves through the role, or null when that
 * can't be read: the role is gone, changed or not usable yet, or AWS refused. Null is never evidence of a deletion. */
async function readStack(r:Runtime,c:V5Connection,stackName:string,verify=false):Promise<OwnStack|null> {
  let scope;
  try { scope=await scoped(r,c,'us-east-2','stack',verify); } catch(e) { if (e instanceof ModuleLoadError) throw e; if (awsError(e).code==='AWS_ACCESS_DENIED') return null; throw e; }
  const [{CloudFormationClient,DescribeStacksCommand,DescribeStackResourceCommand},{FetchHttpHandler}]=await loadCloudFormation();
  const client=new CloudFormationClient({region:'us-east-2',credentials:scope.config.aws,ignoreConfiguredEndpointUrls:true,maxAttempts:2,requestHandler:new FetchHttpHandler({requestTimeout:5000})});
  const unreadable=(e:unknown)=>(e as Error)?.name==='ValidationError' || awsError(e).code==='AWS_ACCESS_DENIED';
  try {
    const stack=(await client.send(new DescribeStacksCommand({StackName:stackName}))).Stacks?.[0];
    if (!stack) return null;
    let resource;
    try { resource=(await client.send(new DescribeStackResourceCommand({StackName:stack.StackId,LogicalResourceId:'Connection'}))).StackResourceDetail; }
    catch(e) { if (!unreadable(e)) throw awsError(e); }
    return {stack,resource};
  }
  catch(e) { if (e instanceof ApiError) throw e; if (unreadable(e)) return null; throw awsError(e); }
  finally { client.destroy(); }
}
// Answers a stack deletion once the cleanup has removed what Nightmail created (or listed what it couldn't), or at the
// deadline, well inside CloudFormation's wait. Polled; the disconnect job does the work.
async function answerDeletion(r:Runtime,req:StackRequest,connectionId:string,deadline:number) {
  const c=(await r.db.execute<V5Connection>(sql`SELECT * FROM provider_connections WHERE id=${connectionId}`)).rows[0];
  const busy=c?(await r.db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM provider_connection_regions WHERE connection_id=${connectionId} AND
    (feedback_topic_arn IS NOT NULL OR EXISTS(SELECT FROM jsonb_array_elements(ownership_journal) e WHERE e->>'kind' IS DISTINCT FROM 'identity'))`)).rows[0]!.n:0;
  if (busy && Date.now()<deadline) throw defer(5000);
  const left=c?.disconnect_summary?.leftBehind??[];
  return answerStack(req,'SUCCESS',busy?`${productName} stopped using this account but didn't finish removing what it created in ${busy} region${busy===1?'':'s'}. Delete the remaining nightmail- configuration sets and SNS topics in the AWS console.`
    :left.length?`${productName} stopped using this account. It couldn't remove: ${left.map(e=>e.resource).join(', ')}`
    :`${productName} stopped using this account and removed the configuration sets and topics it created. SES identities stay.`);
}
const knownVersion=(v:unknown)=>typeof v==='string' && (BYO_TEMPLATE_VERSIONS as readonly string[]).includes(v) ? v : null;
const parameters=(stack:OwnStack['stack'])=>Object.fromEntries((stack.Parameters??[]).map(p=>[p.ParameterKey,p.ParameterValue]));
// A Create is this connection's when the stack named for it is that very stack, has its parameters, and is creating its
// Connection resource now (a new stack, or an update adding the resource).
function creating(own:OwnStack,c:V5Connection,req:StackRequest) {
  const p=parameters(own.stack);
  return own.stack.StackId===req.StackId && /^(?:CREATE|UPDATE)_IN_PROGRESS$/.test(own.stack.StackStatus ?? '') && p.ExternalId===c.external_id && p.ConnectionId===c.id && p.WorkspaceId===c.workspace_id
    && p.ResourcePrefix===c.resource_prefix && own.resource?.ResourceType==='Custom::NightmailConnection' && own.resource.ResourceStatus==='CREATE_IN_PROGRESS';
}
// A Delete is real when the stack's Connection resource, with this physical ID, is being deleted. The role goes with it
// when the stack itself is being deleted or a failed create is rolling back; otherwise only the resource goes.
const deleting=(own:OwnStack,req:StackRequest)=>own.stack.StackId===req.StackId && own.resource?.ResourceStatus==='DELETE_IN_PROGRESS' && own.resource.PhysicalResourceId===req.PhysicalResourceId;
export const roleGoing=(own:OwnStack)=>own.stack.StackStatus==='DELETE_IN_PROGRESS' || own.stack.StackStatus==='ROLLBACK_IN_PROGRESS';
const unreadableStack=`${productName} couldn't read this stack through its role, so it kept the connection. Disconnect in ${productName} first, then delete the stack again.`;
async function stackDelete(r:Runtime,c:V5Connection,req:StackRequest,deadline:number) {
  // Once this stack's deletion was confirmed its role may already be gone: the cleanup is only waited for.
  if (c.state==='disconnecting' && c.stack_deleted_at) return answerDeletion(r,req,c.id,deadline);
  const own=await readStack(r,c,c.stack_id!);
  if (!own) { if (Date.now()<deadline) throw defer(30_000);return answerStack(req,'FAILED',unreadableStack); }
  if (!deleting(own,req)) { log('warn',{code:'BYO_STACK_REQUEST_IGNORED',requestType:req.RequestType,stackStatus:own.stack.StackStatus,resourceStatus:own.resource?.ResourceStatus});return; }
  if (!roleGoing(own)) return answerStack(req,'SUCCESS',`The stack keeps its role, so ${productName} keeps using this account.`);
  // The role is deleted only after this answer, so sending stops now and the cleanup runs through it first (a
  // disconnect already under way goes on, now knowing the stack goes too).
  await r.db.transaction(async db=>{
    await lockSendScope(db,c.workspace_id,{settings:'update'});
    const current=await connection(db,c.workspace_id,true);
    if (!current || current.id!==c.id || current.stack_id!==req.StackId) return;
    if (current.state==='disconnecting') { await db.execute(sql`UPDATE provider_connections SET stack_deleted_at=coalesce(stack_deleted_at,now()) WHERE id=${c.id}`);return; }
    await fence(db,current,true);
    await recordAudit(db,systemContext('job'),{action:'connection.delete',workspaceId:c.workspace_id,target:{type:'connection',id:c.id},before:{kind:'byo',region:c.region,state:c.state},reason:'The CloudFormation stack was deleted.',internal:false});
  });
  return answerDeletion(r,req,c.id,deadline);
}
const stackJob:JobHandler=retryDatabaseFailures(async(r,p)=>{
  const req=StackRequest.parse(p.request),[,account,name]=stackArn.exec(req.StackId)!,deadline=Number(p.deadline);
  await Promise.all([loadStsSdk(),loadSetupSdk()]);
  const c=(await r.db.execute<V5Connection>(sql`SELECT * FROM provider_connections WHERE id=${p.connectionId} AND kind='byo' AND template_version='v5'`)).rows[0];
  if (!c) return nobody(req);
  // The connection may have changed since the request was queued.
  const answer=await refusal(r,c,req);
  if (answer) return answer();
  if (req.RequestType==='Delete') return stackDelete(r,c,req,deadline);
  if (req.RequestType==='Update') {
    const version=knownVersion((await readStack(r,c,c.stack_id!))?.stack.Outputs?.find(o=>o.OutputKey==='TemplateVersion')?.OutputValue);
    if (version) await r.db.execute(sql`UPDATE provider_connections SET stack_template_version=${version} WHERE id=${c.id} AND stack_id=${req.StackId}`);
    return answerStack(req,'SUCCESS',`${productName} uses template ${version ?? 'unknown'}.`);
  }
  const fail=async(reason:string)=>{await r.db.execute(sql`UPDATE provider_connections SET stack_error=${reason} WHERE id=${c.id} AND aws_account_id IS NULL`);return answerStack(req,'FAILED',reason);};
  const bound=c.aws_account_id?c:{...c,requested_account:account};
  if (!c.aws_account_id) try { await scoped(r,bound,c.region,'scan',true); }
  catch(e) {
    if (e instanceof ModuleLoadError) throw e;
    const err=awsError(e);
    if ((err.code==='AWS_ACCESS_DENIED' || err.retryable) && Date.now()<deadline) throw defer(15_000);
    return fail(err.code==='AWS_ACCESS_DENIED' ? `${productName} couldn't use the role this stack created. Delete the stack and use the Connect AWS link again without changing its parameters.` : `${productName} couldn't check the role: ${err.message}`);
  }
  // The external ID proves the role; the stack itself proves this request is its own.
  const own=await readStack(r,bound,name,!c.aws_account_id);
  if (!own) { if (Date.now()<deadline) throw defer(15_000);return fail(`${productName} couldn't read this stack through its role. Delete the stack and use the Connect AWS link again without changing its parameters.`); }
  if (!creating(own,c,req)) { log('warn',{code:'BYO_STACK_REQUEST_IGNORED',requestType:req.RequestType,stackStatus:own.stack.StackStatus,resourceStatus:own.resource?.ResourceStatus});return; }
  if (c.aws_account_id) {
    await r.db.execute(sql`UPDATE provider_connections SET stack_id=${req.StackId} WHERE id=${c.id} AND stack_id IS NULL`);
    return answerStack(req,'SUCCESS',`Connected to ${productName}.`);
  }
  try {
    await r.db.transaction(async db=>{
      const role=`arn:aws:iam::${account}:role/${c.stack_name}`;
      if (!(await db.execute(sql`UPDATE provider_connections SET requested_account=${account},aws_account_id=${account},role_arn=${role},state='scanning',stack_id=${req.StackId},stack_template_version=${knownVersion(req.ResourceProperties.TemplateVersion)},stack_error=NULL
        WHERE id=${c.id} AND aws_account_id IS NULL AND (requested_account IS NULL OR requested_account=${account}) AND state<>'disconnecting'`)).rowCount) throw conflict('CONNECTION_CHANGED','The connection changed while its stack was checked.');
      await beginScan(db,bound);
    });
  } catch(e) {
    if ((e as {cause?:{constraint?:string}}).cause?.constraint==='provider_connections_byo_account') return fail(`This AWS account is already connected to another ${productName} workspace.`);
    if (e instanceof ApiError && e.code==='CONNECTION_CHANGED') return fail(`This ${productName} connection changed while the stack was created. Start again from Connect AWS.`);
    throw e;
  }
  await r.db.execute(sql`INSERT INTO jobs(id,workspace_id,type,payload,available_at) VALUES(${'byo.health:'+c.id+':connected'},${c.workspace_id},'byo.health',${JSON.stringify({connectionId:c.id,run:id('run')})}::jsonb,now()+interval '2 minutes') ON CONFLICT(id) DO NOTHING`);
  return answerStack(req,'SUCCESS',`Connected to ${productName}.`);
});
// Health. Hourly (maintenance.ts) and once a stack connects: can the role still be used, is the stack still there, and is
// each sending region still enabled, healthy and out of the sandbox. Findings are shown to the workspace (the connection
// view and /v1/me); nothing is changed in AWS, and only the affected region or feature is reported.
type Issue={code:string;region?:string;message:string};
export async function queueByoHealth(r:Runtime) {
  if (!r.config.multiTenant || !r.config.byoV2) return 0;
  return (await r.db.execute(sql`INSERT INTO jobs(id,workspace_id,type,payload) SELECT 'byo.health:'||c.id||':'||to_char(date_trunc('hour',now()),'YYYYMMDDHH24'),c.workspace_id,'byo.health',jsonb_build_object('connectionId',c.id,'run',gen_random_uuid())
    FROM provider_connections c JOIN workspaces w ON w.id=c.workspace_id WHERE c.kind='byo' AND c.template_version='v5' AND c.aws_account_id IS NOT NULL AND c.state<>'disconnecting' AND w.byo_v2_enabled ON CONFLICT(id) DO NOTHING`)).rowCount ?? 0;
}
const healthJob=runV5(async(r,c)=>{
  if (!c.aws_account_id) return;
  await Promise.all([loadStsSdk(),loadSetupSdk()]);
  const issues:Issue[]=[];let version=c.stack_template_version;
  if (c.stack_id) {
    const own=await readStack(r,c,c.stack_id),stack=own?.stack;
    if (!stack) issues.push({code:'ROLE_UNREACHABLE',message:`${productName} can’t use the role in your AWS account. If its stack was deleted or changed, disconnect and connect again.`});
    else if (/^DELETE_/.test(stack.StackStatus ?? '')) issues.push({code:'STACK_DELETED',message:`The ${productName} stack was deleted in AWS. Disconnect, then connect again to keep sending.`});
    else version=knownVersion(stack.Outputs?.find(o=>o.OutputKey==='TemplateVersion')?.OutputValue) ?? version;
  }
  const regions=(await r.db.execute<{region:string}>(sql`SELECT region FROM provider_connection_regions WHERE connection_id=${c.id} AND sending_state='ready' ORDER BY region`)).rows;
  if (!issues.some(i=>i.code==='ROLE_UNREACHABLE')) for (const {region} of regions) {
    const label=regionLabels[region] ?? region;
    try {
      const aws=await assume(r,region,c.role_arn!,c.external_id,false,byoSessionPolicy('quota',{region,account:c.aws_account_id,connectionId:c.id}),{connectionId:c.id,purpose:'quota'});
      const [{SESv2Client,GetAccountCommand},{FetchHttpHandler}]=await Promise.all([import('@aws-sdk/client-sesv2'),import('@smithy/fetch-http-handler')]);
      const client=new SESv2Client({region,credentials:aws,ignoreConfiguredEndpointUrls:true,maxAttempts:2,requestHandler:new FetchHttpHandler({requestTimeout:8000})});
      let a;try { a=await client.send(new GetAccountCommand({})); } finally { client.destroy(); }
      const review=a.Details?.ReviewDetails,q=a.SendQuota;
      await r.db.execute(sql`UPDATE provider_connection_regions SET scan_facts=scan_facts||${JSON.stringify({production:a.ProductionAccessEnabled,review:review?{status:review.Status??'UNKNOWN',caseId:review.CaseId??null}:null,enforcement:a.EnforcementStatus,sendingEnabled:a.SendingEnabled,
        ...(q?{max24HourSend:q.Max24HourSend,maxSendRate:q.MaxSendRate,sentLast24Hours:q.SentLast24Hours}:{})})}::jsonb WHERE connection_id=${c.id} AND region=${region}`);
      if (a.SendingEnabled===false) issues.push({code:'SENDING_PAUSED',region,message:`AWS paused sending for this account in ${label}. Check the SES console.`});
      else if (a.EnforcementStatus==='SHUTDOWN' || a.EnforcementStatus==='PROBATION') issues.push({code:'SES_'+a.EnforcementStatus,region,message:`AWS put SES in ${label} on ${a.EnforcementStatus==='SHUTDOWN'?'shutdown':'probation'}. Check the SES console.`});
      if (a.ProductionAccessEnabled===false) issues.push({code:'PRODUCTION_ACCESS_LOST',region,message:`${label} is back in the SES sandbox: mail reaches only verified addresses.`});
    } catch(e) {
      if (e instanceof ModuleLoadError) throw e;
      const err=awsError(e);
      if (err.code==='AWS_ACCESS_DENIED') issues.push({code:'ROLE_CHANGED',region,message:`AWS refused a permission ${productName} needs in ${label}. Update the stack, or check changes made to its role.`});
      else if (!err.retryable) throw err;
    }
  }
  await r.db.execute(sql`UPDATE provider_connections SET health=${JSON.stringify({checkedAt:new Date().toISOString(),issues})}::jsonb,stack_template_version=coalesce(${version},stack_template_version) WHERE id=${c.id}`);
  log(issues.length?'warn':'info',{code:'BYO_HEALTH',connectionId:c.id,issues:issues.map(i=>i.code)});
});

// Updating the stack. Nightmail prepares a change set of the customer's own stack from its newest published template,
// keeping every parameter (so the stack name, role and external ID stay); the customer reviews and runs it in AWS.
export const StackUpdate=z.object({version:z.string(),changeSetId:z.string(),consoleUrl:z.url()}).openapi('ConnectionStackUpdate');
export async function prepareStackUpdate(r:Runtime,wid:string) {
  const c=await requiredV5(r,wid);
  if (!c.aws_account_id || !c.stack_id || !c.stack_name) throw conflict('STACK_UNKNOWN',`This connection has no stack ${productName} can update. Update it in the CloudFormation console.`);
  const latest=BYO_TEMPLATE_VERSIONS.at(-1)!;
  if (versionAtLeast(c.stack_template_version,latest)) throw conflict('STACK_UP_TO_DATE',`The stack already runs template ${latest}.`);
  const platform=requirePlatformAccount(r.config.platformAccount),templateUrl=byoTemplateUrl(platform,latest),changeSet=`nightmail-update-${latest.replace('.','-')}-${Date.now().toString(36)}`;
  await Promise.all([loadStsSdk(),loadSetupSdk()]);
  const aws=await assume(r,'us-east-2',c.role_arn!,c.external_id,false,byoSessionPolicy('update',{region:'us-east-2',account:c.aws_account_id,connectionId:c.id,stack:c.stack_name,templateUrl,changeSet}),{connectionId:c.id,purpose:'update'});
  const [{CloudFormationClient,DescribeStacksCommand,CreateChangeSetCommand},{FetchHttpHandler}]=await loadCloudFormation();
  const client=new CloudFormationClient({region:'us-east-2',credentials:aws,ignoreConfiguredEndpointUrls:true,maxAttempts:2,requestHandler:new FetchHttpHandler({requestTimeout:8000})});
  try {
    const stack=(await client.send(new DescribeStacksCommand({StackName:c.stack_id}))).Stacks?.[0];
    if (!stack || /^DELETE_/.test(stack.StackStatus ?? '')) throw conflict('STACK_UNKNOWN',`The ${productName} stack is gone. Disconnect, then connect again.`);
    const out=await client.send(new CreateChangeSetCommand({StackName:c.stack_id,ChangeSetName:changeSet,ChangeSetType:'UPDATE',TemplateURL:templateUrl,Capabilities:['CAPABILITY_NAMED_IAM'],
      Parameters:(stack.Parameters ?? []).map(p=>({ParameterKey:p.ParameterKey,UsePreviousValue:true})),Description:`${productName} role template ${latest}`}));
    const id=out.Id!;
    return {version:latest,changeSetId:id,consoleUrl:`https://us-east-2.console.aws.amazon.com/cloudformation/home?region=us-east-2#/stacks/changesets/changes?stackId=${encodeURIComponent(c.stack_id)}&changeSetId=${encodeURIComponent(id)}`};
  } catch(e) {
    if (e instanceof ApiError) throw e;
    if (awsError(e).code==='AWS_ACCESS_DENIED') throw conflict('STACK_UPDATE_DENIED',`AWS refused to prepare the update. In the CloudFormation console, update the stack with ${templateUrl} and keep every parameter.`);
    throw awsError(e);
  } finally { client.destroy(); }
}

export const regionalByoJobs:Record<string,JobHandler>={'byo.prove':prove,'byo.scan':scan,'byo.provision':provision,'byo.bind':bind,'byo.disconnect':disconnect,'byo.stack':stackJob,'byo.health':healthJob};
