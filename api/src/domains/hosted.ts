import { matchesAdoption } from '../adopted-identity.js';
import { z } from '@hono/zod-openapi';
import { type SQL, sql, or, eq, like, and, inArray, lt, desc, isNull } from 'drizzle-orm';
import type { GetEmailIdentityCommandOutput } from '@aws-sdk/client-sesv2';
import { senderDomainAllowed, actor } from '../core/access.js';
import { lazyModule, denied, ModuleLoadError, ApiError, notFound, wrapModuleLoad } from '../core/errors.js';
import { assertSharedAccount, getSes, preloadSesTransport, assertSesConfigured, region } from '../core/ses.js';
import { log } from '../log.js';
import type { Actor, DbExecutor, Runtime, Config, JobHandler, Ctx } from '../core/types.js';
import { JobDeferred } from '../jobs.js';
import { type ClaimState, type TenantState, type ProofLabel, type IdentityFacts, type ReceivingSetup, domainHosts, receivingSetup, poolReceives, connectionReady, PROOF_LABELS, proofRecordName, hostRemoved, type ClaimEvidence, hostGraceStart, type HostEvidence, checkedHostStatus, transitionClaim, applyClaim, type HostWrite, hostRoutes, LOST_GRACE_MS } from '../states.js';
import { sesRegions } from '../db/ses-regions.js';
import { getRegionSettings } from '../ses-region-state.js';
import { platformDomainOwner, platformHosts, releasedClaimCleanup, domainQuota } from '../domain-claims.js';
import { loadRegistries } from '../domain-registry.js';
import { type DmarcObservation, dmarcView, tryObserveDmarc, localDmarc } from '../dmarc.js';
import { type ReadyConnection, workspaceConnection, forDelivery } from '../provider-credentials.js';
import { byoEnabled } from '../byo-pilot.js';
import { claimTenantName, mxOwnerTag, POOL_INSTALLATION } from '../ses-setup.js';
import type { SetupCheck } from '../record-check.js';
import { type MxReport, mailboxDomains } from '../db/mailbox.js';
import { expectedMx } from '../mailbox-dns.js';
import { dohQuery } from '../public-dns.js';
import { type ReceivingHostRow, establishedHost, baneRecordUse, defaultReceivingHost, baneRecordIssue, type DomainObservation, hostOwners, takenIssue, type ReceivingIssue, refusedCodes, observeReceiving } from '../receiving-host.js';
import { domains, domainClaims } from '../db/operations.js';
import { productName } from '../brand.js';
import { BUILTIN_UNSUPPORTED, BUILTIN_CAPS, builtinLimitsText } from '../builtin-limits.js';
import { tagKey, hasTags } from '../resource-tags.js';
import { withLinkRecords, ownLinkHosts } from '../link-domains.js';
import { scoped } from '../webhooks/crypto.js';

type Sesv2Mod = typeof import('@aws-sdk/client-sesv2');
export const loadOperationsSesv2 = lazyModule((): Promise<Sesv2Mod> => import('@aws-sdk/client-sesv2'));
const dnsState = z.enum(['pending','verified']);
const publicDns = z.object({ parking:z.object({ owner:z.string().describe('The registrar or host, e.g. Porkbun.'), target:z.string().describe('What its record points to, e.g. pixie.porkbun.com.') }).optional().describe('With wildcard: the answer is a registrar\u2019s parking or forwarding record.'), wildcard:z.string().optional().describe('With missing on a CNAME: a wildcard record (e.g. *.example.com) answers this name with an address instead, as it does a random name beside it. Add the CNAME exactly: the specific record wins over the wildcard.'), state:z.enum(['found','missing','wrong_value']).describe('found: public DNS has this record as listed (it may still take SES a few minutes to verify). missing: nothing of this type at the name. wrong_value: the name has a record of this type with another value.'), values:z.array(z.string()).describe('wrong_value only: what public DNS has at the name instead (at most 5). Empty otherwise.'), checkedAt:z.string() })
  .nullable().optional().describe('For pending sending and MAIL FROM records: what public DNS (Cloudflare 1.1.1.1) shows for this record. verifyDomain looks it up now (answers cached up to 30 seconds). Other reads show the last background check, which runs every 15 to 60 minutes for a Hosted domain still pending an hour after it was added. Null when DNS did not answer in time; absent before any check and on other records.');
const dnsRecord = z.object({ name:z.string(), type:z.enum(['CNAME','TXT','MX']), value:z.string(), priority:z.number().optional(), purpose:z.enum(['sending','receiving','mail_from','dmarc','links']).describe(`links: optional, the domain's own link host (links.<domain>) for the unsubscribe and other links ${productName} adds to campaign and marketing mail; shown when the installation has a link domain with Cloudflare for SaaS.`), status:dnsState, note:z.string().optional(), publicDns });
const dmarcSchema=z.object({status:z.enum(['missing','invalid','none','quarantine','reject']),record:z.string().nullable(),source:z.string().nullable().describe('Domain publishing the effective TXT record; may be the organizational domain.'),adkim:z.enum(['r','s']),aspf:z.enum(['r','s']),alignment:z.object({dkim:z.boolean(),spf:z.boolean()})}).nullable().describe('Last DNS and SES observation for this From domain. Null when unchecked, unavailable or stale. Alignment describes configured identifiers, not a delivery verdict.');
export const receivingIssueSchema = z.object({
  code: z.enum(['cname','foreign_mx','split','wildcard','bane_record','host_taken','claimed','delegated','mx_missing','wrong_region','null_mx','proof_stale','identity_stale']).describe(`cname: the host is a CNAME, so it cannot have an MX (RFC 1034). foreign_mx: another provider receives its mail. split: other MX records share its mail. wildcard: a *.domain CNAME or MX answers for it. bane_record: it is one of ${productName}\u2019s own names (custom MAIL FROM, ownership TXT, DKIM). host_taken: another claim, possibly in another workspace, receives on it. claimed: another workspace claimed it, or a name between it and this domain, in any scope. delegated: it is a delegated zone with its own NS records. claimed and delegated hosts never receive here. mx_missing: its MX disappeared after setup. wrong_region and null_mx: its MX points elsewhere in SES or refuses mail. proof_stale / identity_stale: the ownership TXT proof or the SES verification is out of date.`),
  host: z.string(), blocking: z.boolean().describe('True when receiving there cannot work until DNS or the choice changes.'), message: z.string(),
  provider: z.string().nullable().optional(), target: z.string().nullable().optional().describe('The existing CNAME target.'), suggestion: z.string().nullable().optional().describe('A free subdomain to use instead.'),
}).openapi('ReceivingIssue');
export const domainSchema = z.object({ id: z.string(), name: z.string(), region: z.string(), verificationStatus: z.string(), verified: z.boolean(), dkimStatus: z.string(), dmarc:dmarcSchema, ready: z.boolean(), sending:dnsState, receiving:dnsState, mailFromDomain: z.string().nullable(), mailFromStatus: z.string().nullable(), dnsStatus: z.enum(['available', 'unavailable']), dnsUnavailableReason: z.string().nullable(), dns: z.array(dnsRecord),
  dnsHost: z.object({ name: z.string().describe('The provider, e.g. Cloudflare, Vercel, Route 53, GoDaddy or Namecheap.'), zone: z.string().describe('The zone it hosts, which record names are relative to there.'), url: z.string().nullable().describe('The provider\'s DNS page for the zone, when it has a known address.') })
    .nullable().optional().describe(`Where this domain\u2019s DNS is hosted, from its zone\u2019s NS records, alongside publicDns: null when the provider is not one ${productName} recognizes.`),
  dnsIssue: z.object({ code: z.enum(['no_dns']).describe('no_dns: no nameservers serve this domain: it is unregistered, lapsed or mistyped, so its records can\u2019t be published and it can\u2019t verify.'), message: z.string() })
    .nullable().optional().describe('Set when adding the domain (one bounded NS lookup), by Check now and by the background check: the domain has no DNS at all. Never set when DNS couldn\u2019t be read. Fix the name (add the right domain and delete this one) or register the domain.'),
  releasesAt: z.string().nullable().optional().describe('Hosted only: when this domain is released if its records are still unproven (72 hours after it was added). Null once ownership has been proven.'),
  receivingIssue: receivingIssueSchema.nullable().optional().describe('Hosted only: receiving needs attention. Set by the DNS checks that run when a receiving host is suggested or chosen, on Check now and in the hourly recheck. Null when the receiving record is clear.'),
  builtIn: z.boolean().optional().describe(`Hosted only: the workspace\u2019s built-in domain, a subdomain of ${productName}\u2019s own domain that needs no DNS. It sends until a domain of the workspace\u2019s own verifies (limits here and connection.builtinDomain in GET /v1/me say what it sends), receives at every address, and can\u2019t be deleted or changed (409 BUILTIN_DOMAIN).`),
  limits: z.object({ scope: z.enum(['anyone', 'members']).describe('Who it sends to: anyone, or the verified addresses of the workspace\u2019s members.'), perDay: z.number().int().describe('Recipients in a rolling 24 hours.'), perMinute: z.number().int().describe('Recipients in a minute.'),
    unsupported: z.array(z.enum(BUILTIN_UNSUPPORTED)).describe('Request fields a send from it can\u2019t use (refused together, as error.details[].unsupported of 422 BUILTIN_DOMAIN_UNSUPPORTED): from (a subdomain of it), replyTo (elsewhere), headers, attachments, template, scheduledAt, kind (marketing) and campaign.'),
    summary: z.string().describe('The same, in one sentence.') })
    .optional().describe('Built-in domain only: what it sends, before a send finds out. GET /v1/domains/{id} and listDomains.') }).openapi('DomainReadiness');
export const DomainPage = z.object({ data: z.array(domainSchema), nextCursor: z.string().nullable(),
  quota: z.object({ used: z.number().int().describe('Domains in the workspace, across every region and page.'), limit: z.number().int().describe(`How many domains the workspace may have: 100 unless ${productName} set another limit on request.`) }).optional()
    .describe('Hosted only, and only for credentials without domain restrictions. Absent when the workspace sends through its own AWS account, which has no domain total. Adding a domain past the limit fails with DOMAIN_LIMIT_REACHED; at most 10 of them may be unproven at once.') }).openapi('DomainPage');
// The refusal names the domain only when the caller sent its name (`named`): a domain loaded by ID stays unnamed to a key
// whose scope doesn't cover it.
export function allowedDomain(a: Actor, name: string, named = false) { if (!senderDomainAllowed(a.domains, name)) throw denied('DOMAIN_NOT_ALLOWED', 'The API key is not authorized for this domain or its parent domain.', { permission: 'configuration', ...(named ? { scope: `domain:${name}` as const } : {}) }); }
export async function sesCall<T>(operation: (sesv2: Sesv2Mod) => Promise<T>,creatingIdentity=false): Promise<T> {
  const sesv2 = await loadOperationsSesv2();
  try { return await operation(sesv2); } catch (error) {
    if (error instanceof ModuleLoadError || error instanceof ApiError) throw error;
    const provider = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    const name = provider?.name ?? '', status = provider?.$metadata?.httpStatusCode;
    if (creatingIdentity && name==='LimitExceededException') {
      log('error',{code:'SES_IDENTITY_QUOTA_EXHAUSTED',operation:'CreateEmailIdentity',message:'Request additional regional SES identity capacity.'});
      throw new ApiError(409,'SES_IDENTITY_QUOTA_EXHAUSTED','The regional SES identity quota is full. An account operator must request a quota increase before adding another domain.');
    }
    if (status === 403 || /AccessDenied|Unauthorized|InvalidClientTokenId|UnrecognizedClient|ExpiredToken/.test(name)) throw new ApiError(403, 'SES_ACCESS_DENIED', 'AWS denied the SES operation. Check deployment credentials and IAM permissions.');
    if (status === 429 || /TooManyRequests|Throttl|LimitExceeded/.test(name)) throw new ApiError(429, 'SES_RATE_LIMITED', 'The SES control-plane quota was exceeded. Retry after a short delay.', undefined, true);
    if (status === 404 || name === 'NotFoundException') throw new ApiError(404, 'SES_IDENTITY_NOT_FOUND', 'The requested identity does not exist in this SES region.');
    if (status === 409 || name === 'AlreadyExistsException') throw new ApiError(409, 'SES_IDENTITY_EXISTS', 'The identity already exists in this SES region.');
    if (status === 400 || name === 'BadRequestException') throw new ApiError(422, 'SES_INVALID_REQUEST', 'SES rejected the operation. Check the identity, region, and account configuration.');
    throw new ApiError(503, 'SES_UNAVAILABLE', 'SES could not complete the operation. Check service availability and deployment connectivity.', undefined, true);
  }
}
const claimTag = tagKey('domain-claim');
export type Readiness = z.infer<typeof domainSchema>;
/** A domain nobody serves DNS for (record-check.ts dnsZone): unregistered, lapsed or mistyped. It can never verify, so this replaces "add these records". */
export const noDnsIssue = (name: string) => ({ code: 'no_dns' as const, message: `No DNS found for ${name}: check the spelling, or that the domain is registered.` });
export type DomainRef = Pick<Readiness,'id'|'name'|'region'>;
type ProofTimes={receiving_proved_at?:Date|string|null;receiving_identity_at?:Date|string|null;receiving_proof_missed_at?:Date|string|null};
export type HostedDomain = DomainRef & ClaimState & ProofTimes & { setup_check: SetupCheck | null; connection: ReadyConnection & { tenant_state: TenantState;legacy?:boolean }; token: string; proof_label: ProofLabel; identity: IdentityFacts | null; claim_scope:'account'|'exclusive'|'txt'; pool_receiving:boolean; receiving_setup:ReceivingSetup|null; expired:boolean; check_txt:boolean; created_at:string; ever_proven:boolean; dns_first:boolean; hosts: ReceivingHostRow[] };
/** The domain's receiving hosts, its own row first: what every hosted read of a claim carries. `d` is operation_domains. */
export const unavailableDomain = () => new ApiError(409, 'DOMAIN_UNAVAILABLE', 'This SES identity is unavailable for this domain claim.');
export const ownsIdentity = (identity: GetEmailIdentityCommandOutput, token: string) => hasTags(identity.Tags, [{ Key: claimTag, Value: token }]);
export function hostedDomainSelect(wid:string, domainId:string, lock:SQL=sql``) {
  return sql`SELECT d.id,d.name,d.region,to_jsonb(pc) AS connection,dc.token,dc.proof_label,dc.claim_scope,dc.sending_state,dc.receiving_state,dc.receiving_host,dc.lost_since,dc.receiving_lost_since,dc.identity,
    dc.receiving_proved_at,dc.receiving_identity_at,dc.receiving_proof_missed_at,dc.created_at,dc.ever_proven,dc.dns_first,dc.setup_check,domain_claim_expired(dc) AS expired,dc.created_at <= now()-interval '1 hour' AS check_txt,${domainHosts()} AS hosts,${receivingSetup()} AS receiving_setup,
    EXISTS(SELECT 1 FROM provider_pool_regions p WHERE p.region=pc.region AND p.aws_account_id=pc.aws_account_id AND ${poolReceives()}) AS pool_receiving
    FROM operation_domains d JOIN domain_claims dc ON dc.name=d.name AND dc.workspace_id=d.workspace_id
    JOIN domain_sending_bindings b ON b.domain_id=d.id AND b.connection_id=dc.connection_id AND b.region=d.region
    JOIN regional_connections pc ON pc.id=b.connection_id AND pc.workspace_id=dc.workspace_id AND pc.region=b.region AND ${connectionReady()}
    WHERE d.workspace_id=${wid} AND d.id=${domainId} ${lock}`;
}
export async function hostedDomain(db: DbExecutor, wid: string, domainId: string, lock=false, recheck?: { domains:readonly string[]; mode:'manual'|'dashboard'; platformAccount?:string }) {
  const target=hostedDomainSelect(wid,domainId,lock ? sql`FOR UPDATE OF dc` : recheck ? sql`FOR SHARE OF dc` : sql``);
  // Authorize the write inside the statement; a restricted key may see a 403 but must never schedule work.
  const allowed = recheck?.domains.length ? sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(recheck.domains)}::jsonb) p(parent)
    WHERE right('.'||name,length(parent)+1)='.'||lower(parent))` : sql`true`;
  const accountFence=recheck?.platformAccount ? sql`AND (connection->>'kind'<>'shared' OR connection->>'aws_account_id' IS NULL OR connection->>'aws_account_id'=${recheck.platformAccount})` : sql``;
  const query = recheck ? sql`WITH target AS (${target}), queued AS (${recheckJob(wid, sql`SELECT id,token FROM target WHERE NOT expired AND NOT coalesce(identity ? 'builtin',false) AND ${allowed} ${accountFence} ${recheck.mode==='dashboard' ? sql`AND sending_state='pending'` : sql``}`,recheck.mode)})
    SELECT target.*,EXISTS(SELECT 1 FROM queued) AS queued FROM target` : target;
  return (await db.execute<HostedDomain & {queued?:boolean}>(query)).rows[0];
}
export const dnsUnavailable = () => new ApiError(503,'DOMAIN_DNS_UNAVAILABLE','DNS did not return a definitive answer. Verification will retry.',undefined,true);
export async function identityQuotaAlert(runtime:Runtime,region:string,account:string,error:unknown){
  if(!(error instanceof ApiError) || error.code!=='SES_IDENTITY_QUOTA_EXHAUSTED')return;
  await runtime.db.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload) VALUES('identity-quota:'||${account}::text||':'||${region}::text||':'||to_char(now() AT TIME ZONE 'UTC','YYYYMMDD'),'reputation.alert',${runtime.config.workspaceId},jsonb_build_object('code','SES_IDENTITY_QUOTA_EXHAUSTED','region',${region}::text)) ON CONFLICT DO NOTHING`);
}
async function txtProof(name: string, token: string) {
  try {
    const answer = await dohQuery(name, 'TXT', AbortSignal.timeout(5000));
    return answer.Status === 0 && !!answer.Answer?.some(rr => rr.type === 16 && rr.name.toLowerCase().replace(/\.$/, '') === name && (rr.data === `"${token}"` || rr.data === token));
  } catch { throw dnsUnavailable(); }
}
// Any published label proves the same stored token. A resolver error is not proof of loss.
async function ownershipTxt(domain: string, token: string) {
  let failed = false;
  for (const label of PROOF_LABELS) {
    try { if (await txtProof(proofRecordName(label, domain), token)) return true; }
    catch { failed = true; }
  }
  if (failed) throw dnsUnavailable();
  return false;
}
const state = (verified:boolean) => verified ? 'verified' as const : 'pending' as const;
export function readiness(row: DomainRef, value: Partial<GetEmailIdentityCommandOutput>, hosted?: { token:string; label:ProofLabel; shared:boolean; regional?:boolean; proven:boolean; imported?:boolean; txtOwned?:boolean }, mx?:MxReport|null, note?:string|null, observation?:DmarcObservation|null): Readiness {
  const dkim = value.DkimAttributes, suffix = dkim?.SigningHostedZone;
  const signed = dkim?.Status === 'SUCCESS' && dkim.SigningEnabled === true;
  const dns: z.infer<typeof domainSchema>['dns'] = [];
  let dnsUnavailableReason: string | null = null;
  if (dkim?.SigningAttributesOrigin === 'EXTERNAL') dnsUnavailableReason = 'Bring-your-own DKIM records must be obtained from the identity owner.';
  else if (!suffix || !/^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,63}\.?$/.test(suffix) || !dkim?.Tokens?.length) dnsUnavailableReason = 'SES did not return an authoritative DKIM signing zone and tokens; DNS records are unavailable.';
  else dns.push(...dkim.Tokens.map(token => ({ name: `${token}._domainkey.${row.name}`, type: 'CNAME' as const, value: `${token}.${suffix}`, purpose:'sending' as const,status:state(signed) })));
  const mailFrom = value.MailFromAttributes;
  if (mailFrom?.MailFromDomain) {
    if (/^(?:us-(?:east|west)|af-south|ap-(?:east|south|northeast|southeast)|ca-(?:central|west)|eu-(?:central|north|south|west)|il-central|me-(?:south|central)|mx-central|sa-east)-\d+$/.test(row.region)) {
      const purpose={purpose:'mail_from' as const,status:state(mailFrom.MailFromDomainStatus==='SUCCESS')};
      dns.push({ name: mailFrom.MailFromDomain, type: 'MX', value: `feedback-smtp.${row.region}.amazonses.com`, priority: 10, ...purpose });
      dns.push({ name: mailFrom.MailFromDomain, type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', ...purpose });
    } else dnsUnavailableReason = 'MAIL FROM DNS instructions are supported only for commercial AWS regions.';
  }
  let verified = value.VerifiedForSendingStatus === true, verificationStatus = value.VerificationStatus ?? 'NOT_STARTED';
  if (hosted) {
    if (hosted.shared) dns.push({ name:proofRecordName(hosted.label,row.name),type:'TXT',value:hosted.token,purpose:'sending',status:state(hosted.proven) });
    if (hosted.imported) dns.push({name:proofRecordName(hosted.label,row.name),type:'TXT',value:hosted.token,purpose:'sending',status:state(hosted.txtOwned===true),note:'Optional for sending. Publish this record and verify the domain to claim exclusive ownership.'});
    verified = verified && hosted.proven && signed && (hosted.imported || (new Set(dkim?.Tokens).size===3 && (!dkim?.SigningAttributesOrigin || dkim.SigningAttributesOrigin==='AWS_SES')));
    if (!verified && verificationStatus === 'SUCCESS') verificationStatus = 'PENDING';
  }
  const ready = verified && signed;
  dns.push({...(mx?.expected ?? expectedMx(row.name,hosted?.shared && hosted.regional ? 'us-east-2' : row.region)),purpose:'receiving',status:state(mx?.state==='active'),...(note ? {note} : {})});
  const dmarc=dmarcView(observation,value);
  if(dmarc?.status==='missing' && observation?.recommend) dns.push({name:`_dmarc.${row.name}`,type:'TXT',value:'v=DMARC1; p=none',purpose:'dmarc',status:'pending',note:`Recommended only if no policy exists. ${productName} does not collect aggregate reports.`});
  return { id: row.id, name: row.name, region: row.region, verificationStatus, verified, dkimStatus: dkim?.Status ?? 'NOT_STARTED', dmarc, ready, sending:state(ready),receiving:state(mx?.state==='active' && value.VerificationStatus==='SUCCESS' && (hosted?.proven ?? true)), mailFromDomain: mailFrom?.MailFromDomain ?? null, mailFromStatus: mailFrom?.MailFromDomainStatus ?? null, dnsStatus: dnsUnavailableReason ? 'unavailable' as const : 'available' as const, dnsUnavailableReason, dns };
}
// The operator-adopted platform domain (scripts/adopt-platform-domain.ts) receives on its Ohio connection while its
// workspace stays configured. Every other adoption is send-only.
const platformClaim = (config:Config,wid:string,row:{name:string;identity:IdentityFacts|null;connection:Pick<ReadyConnection,'kind'> & {legacy?:boolean}}) =>
  !!row.identity?.adopted && row.connection.kind==='shared' && row.connection.legacy!==false && platformDomainOwner(config,wid) && platformHosts(config).includes(row.name);
const claimProof = (row: {connection:Pick<ReadyConnection,'kind'> & {legacy?:boolean};token:string;proof_label:ProofLabel;identity?:IdentityFacts|null;claim_scope?:string}, proven=false) => ({ token:row.token,label:row.proof_label,shared:row.connection.kind==='shared',regional:row.connection.legacy===false,proven,imported:row.connection.kind==='byo' && row.identity?.imported===true,txtOwned:row.claim_scope==='txt' });
type ClaimRow = DomainRef & ClaimState & ProofTimes & { setup_check?:SetupCheck|null; token:string; proof_label:ProofLabel; identity:IdentityFacts|null; connection:Pick<ReadyConnection,'kind'> & {legacy?:boolean}; created_at?:string|Date; ever_proven?:boolean; dns_first?:boolean; hosts?:ReceivingHostRow[] };
const hour=3600_000;
const proofTime=(at:Date|string|null|undefined)=>at?new Date(at).getTime():0;
const proofUntil=(row:ProofTimes)=>Math.min(proofTime(row.receiving_proved_at)+72*hour,row.receiving_proof_missed_at?proofTime(row.receiving_proof_missed_at)+48*hour:Infinity);
const observeProof=(positive:boolean)=>sql`receiving_proved_at=CASE WHEN ${positive} THEN now() ELSE receiving_proved_at END,receiving_proof_missed_at=CASE WHEN NOT ${positive} THEN coalesce(receiving_proof_missed_at,now()) END`;
const sends = (row: Pick<ClaimState,'sending_state'>) => row.sending_state==='verified' || row.sending_state==='lost';
/**
 * A Hosted domain's re-check on request (POST /v1/domains/{id}/verify, and support's DNS re-check): queues a background
 * verification unless one is already due, and returns the stored status.
 */
export async function verifyHostedDomain(runtime: Runtime, a: Actor, domainId: string) {
  const row=await hostedDomain(runtime.db,a.workspaceId,domainId,false,{domains:a.domains,mode:'manual',platformAccount:runtime.config.platformAccount}) ?? notFound('Domain'); allowedDomain(a,row.name);
  assertSharedAccount(runtime,row.connection);
  // Check now covers every receiving host: the background verification observes them all, and one still waiting for its MX
  // is followed up (followMxJob).
  if ((await runtime.db.execute(followMxJob(a.workspaceId,sql`SELECT ${row.id}::text AS id,${row.token}::uuid AS token`))).rowCount || row.queued) a.wakeJobs=1;
  return derivedReadiness(row, runtime.config);
}
/** The readiness document is derived: SES/DNS facts give the records, the explicit states give every boolean. */
export function derivedReadiness(row: ClaimRow, config?: Pick<Config, 'builtinScope'>): Readiness {
  const facts=row.identity, held=sends(row);
  // The built-in domain has no DNS records of its own: it sends under its parent's identity and receives on its name.
  if (facts?.builtin) return { id:row.id, name:row.name, region:row.region, verificationStatus:held ? 'SUCCESS' : 'PENDING', verified:held, dkimStatus:held ? 'SUCCESS' : 'PENDING', dmarc:null, ready:held, sending:state(held),
    receiving:state(row.receiving_state==='active' || row.receiving_state==='lost'), mailFromDomain:facts.ses.MailFromAttributes?.MailFromDomain ?? null, mailFromStatus:facts.ses.MailFromAttributes?.MailFromDomainStatus ?? null,
    dnsStatus:'available', dnsUnavailableReason:null, dns:[], releasesAt:null, receivingIssue:null, builtIn:true,
    ...(config ? { limits: { scope: config.builtinScope, ...BUILTIN_CAPS[config.builtinScope], unsupported: [...BUILTIN_UNSUPPORTED], summary: builtinLimitsText(config.builtinScope) } } : {}) };
  const report=readiness(row,facts?.ses ?? {VerificationStatus:'PENDING'},claimProof(row,(facts?.proven ?? false) || held),facts?.mx,facts?.note,facts?.dmarc);
  if(row.dns_first && !row.ever_proven){
    if(!report.dns.some(record=>record.name===proofRecordName(row.proof_label,row.name))) report.dns.unshift({name:proofRecordName(row.proof_label,row.name),type:'TXT',value:row.token,purpose:'sending',status:'pending'});
    report.dnsUnavailableReason='Publish the ownership TXT record first. DKIM records follow after DNS proof.';
  }
  report.verified=held; report.ready=held; report.sending=state(held);
  if (row.sending_state==='failed') report.verificationStatus='FAILED';
  else if (!held && report.verificationStatus==='SUCCESS') report.verificationStatus='PENDING';
  report.receiving=state(row.receiving_state==='active' || row.receiving_state==='lost');
  // Receiving: one MX record per host, the domain's own row first. That row's host floats with the suggestion until it
  // routes: never the root unless it already routes here or the owner chose it (an MX pasted at the root would take the
  // domain's existing mail), and never one of Nightmail's own names. DNS checks refine this to a free host. Every other
  // host is exactly where it was added, and a host the owner removed has no record.
  const ses=facts?.ses, chosen=facts?.receivingChoice ?? null, hosts=row.hosts ?? [], own=hosts.find(h=>h.own), established=establishedHost(row);
  const others=hosts.filter(h=>!h.own && !hostRemoved(h.status));
  const rootActive=established===row.name || chosen===row.name || (facts?.mx?.expected.name===row.name && facts.mx.state==='active');
  const receivingName=(name:string)=>established ?? (chosen && !baneRecordUse(chosen,row.name,ses) ? chosen : (name===row.name && !rootActive) || baneRecordUse(name,row.name,ses) ? defaultReceivingHost(row.name,ses) : name);
  const template=report.dns.find(r=>r.purpose==='receiving');
  report.dns=report.dns.flatMap(r=>r.purpose!=='receiving' ? [r] : own?.status==='disabled' ? [] : [{...r,name:receivingName(r.name),status:state(established!==null)}]);
  if (template) report.dns.push(...others.map(h=>({name:h.host,type:'MX' as const,value:template.value,priority:template.priority,purpose:'receiving' as const,status:state(h.status==='active' || h.status==='provisioning')})));
  const shown=own?.status==='disabled' ? null : report.dns.find(r=>r.purpose==='receiving')?.name;
  report.receivingIssue=(established ? baneRecordIssue(established,row.name,ses,row.region,null) : null) ?? (shown && facts?.issue && facts.issue.host===shown ? facts.issue : null) ?? others.find(h=>h.issue)?.issue ?? null;
  if(row.receiving_host && report.receiving==='verified'){
    const deadline=Math.min(proofUntil(row),proofTime(row.receiving_identity_at)+96*hour),blocking=deadline<=Date.now();
    const stale=!!row.receiving_proof_missed_at || proofTime(row.receiving_proved_at)<Date.now()-24*hour;
    if(stale || proofTime(row.receiving_identity_at)<Date.now()-48*hour){
      report.receivingIssue={code:stale?'proof_stale':'identity_stale',host:row.receiving_host,blocking,message:`${stale?'Recheck the ownership TXT record':'Recheck the SES domain identity'}. ${blocking?'New mail is held until verification succeeds.':`New mail will be held after ${new Date(deadline).toISOString()} if verification does not succeed.`}`};
      if(blocking)report.receiving='pending';
    }
  }
  // No DNS setup is authorized by a send-only operator attestation. The adopted platform domain also receives: it
  // shows only its receiving MX, since its DKIM records predate the claim and the attestation replaces the TXT.
  if (facts?.adopted) report.dns=facts.receivingChoice || row.receiving_state!=='off' ? report.dns.filter(r=>r.purpose==='receiving') : [];
  // The last background DNS check of a domain still pending (domain-setup.ts): each pending record's state, and its DNS host.
  const check=row.setup_check;
  if (check && !held) {
    for (const r of report.dns) if (r.status==='pending' && (r.purpose==='sending' || r.purpose==='mail_from')) {
      const seen=check.records.find(c=>c.type===r.type && c.name===r.name && c.value===r.value);
      if (seen) r.publicDns=seen.publicDns;
    }
    report.dnsHost=check.host;
    report.dnsIssue=check.noDns ? noDnsIssue(row.name) : null;
  }
  if (row.created_at!==undefined && row.ever_proven===false && !held) report.releasesAt=new Date(new Date(row.created_at).getTime()+72*3600_000).toISOString();
  else if (row.ever_proven!==undefined) report.releasesAt=null;
  return report;
}
const identityBinding = (row:Pick<HostedDomain,'name'|'region'|'connection'>,wid:string) => ({TenantName:claimTenantName(row.connection,wid), ResourceArn:`arn:aws:ses:${row.region}:${row.connection.aws_account_id}:identity/${row.name}`});

// The caller holds the claim lock. Only a full identity check can change eligibility; an MX-only
// observation may change routing but can never grant ownership or qualify an unverified SES identity.
async function saveObservation(db:DbExecutor,row:HostedDomain,wid:string,ses:IdentityFacts['ses'],observation:DomainObservation|undefined,evidence:Pick<ClaimEvidence,'sending'|'sendingRevoked'|'identityVerified'|'proven'|'unavailable'|'definitive'>,dmarc=row.identity?.dmarc) {
  const byo=row.connection.kind==='byo', established=establishedHost(row), seen=observation?.own;
  const ownRow=row.hosts.find(h=>h.own), others=row.hosts.filter(h=>!h.own);
  // Nightmail's MX is live at a host when it answers there, alone or beside another provider's (a backup MX while mail
  // moves over): such a host takes whatever mail reaches it, and its issue says how the mail is split.
  const live=(mx:MxReport)=>mx.state==='active' || mx.state==='mixed';
  let observed=seen ? (live(seen.mx) ? seen.mx.expected.name : null) : undefined;
  let note=seen ? seen.note ?? null : row.identity?.note ?? null;
  let issue=seen ? seen.issue : row.identity?.issue ?? null;
  // Never route mail on a name Nightmail publishes for another purpose (custom MAIL FROM, ownership TXT, DKIM).
  const reserved=observed && observed!==established ? baneRecordIssue(observed,row.name,ses,row.region,null) : null;
  if (reserved) { issue=reserved; observed=null; }
  if (observed && observed!==established) {
    // A workspace may claim both example.com and reply.example.com, and another workspace may hold the host too. Never
    // route one address twice (mailbox_domains_routing_host enforces it).
    const owner=(await hostOwners(db,[observed],wid,row.name)).taken.get(observed);
    if (owner) { issue=takenIssue(observed,owner,null); note=issue.message; observed=null; }
  }
  // A host another workspace has claimed (in any scope) or delegated to its own name servers is never routed here.
  if (observed && issue?.host===observed && (issue.code==='claimed' || issue.code==='delegated')) observed=null;
  // The domain's own row: where it routes, or where its MX should go until it does. The primary host's MX grace is the
  // claim's (every Worker keeps it, so one that doesn't know lost_since can't leave a stale one behind); the others' their rows'.
  const ownHost=established ?? seen?.mx.expected.name ?? ownRow?.host ?? row.identity?.mx?.expected.name ?? defaultReceivingHost(row.name,ses);
  const seed=(h:ReceivingHostRow)=>h.status==='active' ? hostGraceStart(row,h) : null;
  const hostIssues=new Map<string,ReceivingIssue|null>();
  // An MX-only observation never routes a new host without fresh ownership proof.
  const allow=(h:{status:string},on:boolean|undefined)=>on===undefined ? undefined : on && (evidence.proven || h.status==='active');
  const own:HostEvidence|null=ownRow?.status==='disabled' ? {host:ownRow.host,status:'disabled',lost_since:null,live:undefined}
    : {host:ownHost,status:ownRow ? checkedHostStatus(ownRow.status) : 'waiting_for_mx',lost_since:ownRow ? seed(ownRow) : null,live:allow(ownRow ?? {status:'waiting_for_mx'},observed===undefined ? undefined : observed!==null)};
  const evidenceFor=(h:ReceivingHostRow):HostEvidence=>{
    const seenThere=observation?.hosts.get(h.host);
    if (seenThere) hostIssues.set(h.host,seenThere.issue);
    return {host:h.host,status:checkedHostStatus(h.status),lost_since:seed(h),live:allow(h,seenThere ? live(seenThere.mx) && !(seenThere.issue && refusedCodes.has(seenThere.issue.code)) : undefined)};
  };
  let input=[own,...others.map(evidenceFor)];
  const regionReceives=row.claim_scope!=='account' && (byo || row.pool_receiving);
  const transition=()=>{
    const n=transitionClaim(row,{...evidence,regionReceives,byo},input);
    // The ownership grace preserves hosts still bound to their MX only. It cannot activate another host, revive a
    // disconnected claim, or overrule a negative SES observation.
    if(!evidence.proven && evidence.identityVerified && !evidence.definitive && !evidence.unavailable && regionReceives && ['active','lost'].includes(row.receiving_state) && proofUntil(row)>Date.now()
      && input.some(h=>h.status==='active' && h.live)) return transitionClaim(row,{...evidence,proven:true,regionReceives,byo},input.map(h=>({...h,live:h.status==='provisioning' ? false : h.live===undefined ? undefined : h.live && h.status==='active'})));
    return n;
  };
  let next=transition();
  const ref={name:row.name,token:row.token,connectionId:row.connection.id,workspaceId:wid,domainId:row.id,region:row.region};
  const apply=async()=>{
    // Managed sending identities confer no receiving rights (including Virginia). Only a
    // separately reviewed receiving binding may change that projection in phase 2.
    if (row.connection.legacy===false) return applyClaim(db,ref,next.claim,{ses,dmarc,proven:evidence.proven,mx:row.identity?.mx??null,note,imported:row.identity?.imported,adopted:row.identity?.adopted},null);
    const mx=next.claim.receiving_state==='lost' ? row.identity?.mx ?? null : seen?.mx ?? row.identity?.mx ?? null;
    const writes:HostWrite[]=input.map((h,i)=>{
      const at=i===0 ? ownRow : others[i-1];
      // The domain's own row keeps the report the claim keeps, as every Worker writes it.
      return {...next.hosts[i]!,id:at?.id ?? null,host:h.host,...(i===0 ? {mx,issue:h.status==='disabled' ? null : issue} : {mx:observation?.hosts.get(h.host)?.mx ?? null,issue:hostIssues.has(h.host) ? hostIssues.get(h.host)! : at?.issue ?? null})};
    });
    await applyClaim(db,ref,next.claim,{ses,dmarc,proven:evidence.proven,mx,note,issue,receivingChoice:row.identity?.receivingChoice ?? null,imported:row.identity?.imported,adopted:row.identity?.adopted},writes);
  };
  const newlyRouting=()=>input.filter((h,i)=>hostRoutes(next.hosts[i]!.status) && !hostRoutes(h.status)).map(h=>h.host);
  if (newlyRouting().length) {
    // Two domains can both read a host as free above and then race to route it; the unique indexes decide. The loser
    // reports host_taken on that host instead of failing the job (the savepoint keeps the transaction usable).
    await db.execute(sql`SAVEPOINT receiving_host_claim`);
    try { await apply(); await db.execute(sql`RELEASE SAVEPOINT receiving_host_claim`); }
    catch (e) {
      if (!receivingHostConflict(e)) throw e;
      await db.execute(sql`ROLLBACK TO SAVEPOINT receiving_host_claim`);
      const owners=(await hostOwners(db,newlyRouting(),wid,row.name)).taken, lost=newlyRouting().filter(host=>owners.has(host));
      for (const host of lost.length ? lost : newlyRouting()) {
        const taken=takenIssue(host,owners.get(host) ?? {own:false,name:''},null);
        if (host===input[0]!.host) { issue=taken; note=taken.message; } else hostIssues.set(host,taken);
        input=input.map(h=>h.host===host ? {...h,live:false} : h);
      }
      next=transition();
      await apply();
    }
  } else await apply();
  // The grace after its DNS records went missing has run out: mail from the domain is refused from here on, and its
  // owners are told once (an identity that SES revoked or lost is another story, and has no email).
  if (row.sending_state==='lost' && next.claim.sending_state==='pending' && !evidence.definitive && !evidence.unavailable && !evidence.sendingRevoked)
    await (await wrapModuleLoad(() => import('../account-notices.js'))).domainUnverified(db,wid,{id:row.id,name:row.name,lostSince:row.lost_since ? String(row.lost_since) : null});
  if (row.connection.legacy===false) return next.claim;
  if (byo && (next.claim.receiving_host!==row.receiving_host || next.hosts.some((s,i)=>s.status==='provisioning' || hostRoutes(s.status)!==hostRoutes(input[i]!.status)))) await (await wrapModuleLoad(() => import('../mailbox-setup.js'))).queueReconcile(db,wid,row.region);
  return next.claim;
}
const receivingHostConflict=(error:unknown)=>{
  const e=((error as {cause?:unknown})?.cause ?? error) as {code?:string;constraint?:string};
  return e?.code==='23505' && ['domain_claims_receiving_host','domain_claims_routing','mailbox_domains_routing_host'].includes(e.constraint ?? '');
};
// Same DNS checks for "Check MX now" (domain.verify), the hourly sweep (domain.mx) and an explicit choice; see receiving-host.ts.
const receivingMx=(db:DbExecutor,row:HostedDomain,wid:string):Promise<DomainObservation>=>observeReceiving(db,row,wid,dnsUnavailable);
export const sesFacts = (identity: Partial<GetEmailIdentityCommandOutput>): IdentityFacts['ses'] => ({ VerificationStatus: identity.VerificationStatus, VerifiedForSendingStatus: identity.VerifiedForSendingStatus, DkimAttributes: identity.DkimAttributes, MailFromAttributes: identity.MailFromAttributes });
// Creates this claim's tagged identity, or adopts the one an earlier lost response left behind. Never adopts by name.
async function ensureIdentity(client: Awaited<ReturnType<typeof getSes>>, name: string, token: string,installation?:string,regionalByo=false) {
  try {
    return await sesCall(({ CreateEmailIdentityCommand })=>client.send(new CreateEmailIdentityCommand({EmailIdentity:name,DkimSigningAttributes:{NextSigningKeyLength:'RSA_2048_BIT'},Tags:[{Key:claimTag,Value:token},...(installation?[mxOwnerTag,{Key:tagKey('installation-id'),Value:installation}]:[]),...(regionalByo?[{Key:tagKey('purpose'),Value:'domain-identity'}]:[])]})),true);
  } catch(e) {
    if (!(e instanceof ApiError) || e.code!=='SES_IDENTITY_EXISTS') throw e;
    const existing=await sesCall(({ GetEmailIdentityCommand })=>client.send(new GetEmailIdentityCommand({EmailIdentity:name})));
    // A connected account's identity Nightmail didn't create is never changed: it can only be imported, as it is.
    if (regionalByo && !ownsIdentity(existing,token)) throw new ApiError(409,'DOMAIN_EXISTS_IN_ACCOUNT',`${name} already exists in this AWS account's SES, set up outside ${productName}. Import it from the domains found in your account, and ${productName} uses it as it is, or remove it in SES first.`);
    // A connected account's identity Nightmail didn't create is never changed: it can only be imported, as it is.
    if (regionalByo && !ownsIdentity(existing,token)) throw new ApiError(409,'DOMAIN_EXISTS_IN_ACCOUNT',`${name} already exists in this AWS account's SES, set up outside ${productName}. Import it from the domains found in your account, and ${productName} uses it as it is, or remove it in SES first.`);
    if (!ownsIdentity(existing,token) || regionalByo && !hasTags(existing.Tags,[mxOwnerTag,{Key:tagKey('installation-id'),Value:installation!},{Key:tagKey('purpose'),Value:'domain-identity'}])) throw unavailableDomain();
    return existing;
  }
}
// A retried/reconnected creation or a verifier can recover an old claim right at its deadline.
// Recheck and hold the row across Create so recovery cannot recreate the identity after expiry cleanup.
export const identityJournalEntry=(row:Pick<HostedDomain,'connection'|'region'|'name'|'token'>)=>({kind:'identity',resource:`arn:aws:ses:${row.region}:${row.connection.aws_account_id}:identity/${row.name}`,claim:row.token});
export function recoverIdentity(runtime:Runtime,wid:string,domainId:string,token:string,client:Awaited<ReturnType<typeof getSes>>) {
  return runtime.db.transaction(async db=>{
    const current=await hostedDomain(db,wid,domainId,true);
    if (current && current.token===token && !current.expired && !current.identity?.adopted) {
      assertSharedAccount(runtime,current.connection);
      if (current.dns_first && !current.ever_proven) return null;
      const regionalByo=current.connection.kind==='byo' && current.connection.legacy===false;
      const pooled=current.connection.kind==='shared' && runtime.config.trustedPool;
      const identity=await ensureIdentity(client,current.name,token,pooled?POOL_INSTALLATION:current.connection.legacy===false || (runtime.config.regionalSending && current.connection.kind==='shared')?current.connection.id:undefined,regionalByo || pooled);
      // A configuration-set SNS destination already receives feedback. Do this only after create or a
      // tag-checked recovery, never on a customer import or an operator-adopted identity.
      if (!('FeedbackForwardingStatus' in identity) || identity.FeedbackForwardingStatus !== false) {
        try { await sesCall(({PutEmailIdentityFeedbackAttributesCommand}) => client.send(new PutEmailIdentityFeedbackAttributesCommand({EmailIdentity:current.name,EmailForwardingEnabled:false}))); }
        catch (error) {
          if (!(error instanceof ApiError)) throw error;
          log('warn',{code:'SES_FEEDBACK_FORWARDING_NOT_DISABLED',workspaceId:wid,domain:current.name,region:current.region,reason:error.code});
        }
      }
      if (regionalByo) {
        const entry=JSON.stringify([identityJournalEntry(current)]);
        await db.execute(sql`UPDATE provider_connection_regions SET ownership_journal=ownership_journal||${entry}::jsonb WHERE connection_id=${current.connection.id} AND region=${current.region} AND NOT ownership_journal @> ${entry}::jsonb`);
      }
      return identity;
    }
  });
}
// Removes only this claim's tagged identity (and, in the shared pool, its tenant association). Used by
// domain deletion and by disconnecting a shared connection, so a later reconnect never meets its own ghost.
export async function deleteClaimIdentity(runtime:Runtime,wid:string,row:Pick<HostedDomain,'name'|'region'|'token'|'connection'>) {
  const client=await getSes({...runtime,config:{...runtime.config,regions:[row.region]}},row.region,{...row.connection,identitySession:{name:row.name,purpose:'delete'}});
  const ignoreMissing=async <T>(fn:(sesv2: Sesv2Mod)=>Promise<T>)=>{ try {return await sesCall(fn);} catch(e){if (!(e instanceof ApiError) || e.code!=='SES_IDENTITY_NOT_FOUND') throw e;} };
  const identity=await ignoreMissing(({ GetEmailIdentityCommand })=>client.send(new GetEmailIdentityCommand({EmailIdentity:row.name})));
  if (!identity || !ownsIdentity(identity,row.token)) return;
  // Read actual SES membership, not readiness: DNS can regress, or the association acknowledgement can be lost.
  // The caller holds the claim lock through deletion, or has fenced its connection (deleteConnectionIdentities), so a
  // concurrent release/re-claim cannot delete a new owner's identity.
  if (row.connection.kind==='shared' && row.connection.aws_account_id) {
    const binding=identityBinding(row,wid); let next: string | undefined;
    do {
      const page=await sesCall(({ ListResourceTenantsCommand })=>client.send(new ListResourceTenantsCommand({ResourceArn:binding.ResourceArn,NextToken:next})));
      if (page.ResourceTenants?.some(t=>t.TenantName===binding.TenantName)) {
        await ignoreMissing(({ DeleteTenantResourceAssociationCommand })=>client.send(new DeleteTenantResourceAssociationCommand(binding))); break;
      }
      next=page.NextToken;
    } while (next);
  }
  await ignoreMissing(({ DeleteEmailIdentityCommand })=>client.send(new DeleteEmailIdentityCommand({EmailIdentity:row.name})));
}
/** Disconnect: a shared connection's tagged identities are deleted; BYO identities, adopted ones and the built-in domain
 * (a name under the platform's parent identity, with none of its own) are not touched. The caller has fenced the
 * connection (state 'disconnecting'), so no claim read sees it any more; taking the claims' locks first waits out a write
 * already under way (an identity create). No transaction or lock is held across the AWS calls. */
export async function deleteConnectionIdentities(runtime:Runtime,wid:string,connection:HostedDomain['connection'] & {region:string}) {
  if (connection.kind!=='shared') return;
  const claims=(await runtime.db.transaction(db=>db.execute<{name:string;token:string;region:string;managed_tenant:boolean;pool_tenant_name:string|null}>(sql`SELECT dc.name,dc.token,b.region,r.managed_tenant,r.pool_tenant_name FROM domain_claims dc JOIN domain_sending_bindings b USING(workspace_id,name,connection_id) JOIN regional_connections r ON r.id=b.connection_id AND r.region=b.region WHERE dc.workspace_id=${wid} AND dc.connection_id=${connection.id} AND NOT coalesce(dc.identity ?| array['adopted','builtin'],false) FOR UPDATE OF dc`))).rows;
  for (const claim of claims) await deleteClaimIdentity(runtime,wid,{...claim,connection:{...connection,managed_tenant:claim.managed_tenant,pool_tenant_name:claim.pool_tenant_name}});
}
export async function releaseClaim(db:DbExecutor,wid:string,row:{token:string}) {
  await db.execute(sql`WITH released AS (DELETE FROM domain_claims WHERE workspace_id=${wid} AND token=${row.token} RETURNING name,token), ${releasedClaimCleanup(wid)}
    DELETE FROM operation_domains WHERE workspace_id=${wid} AND name IN (SELECT name FROM released)`);
}
/** Each release holds one lock through the tag check, SES deletion and database cleanup. On SES
 * failure retain the claim for the next sweep, without letting it block other expired names. */
export async function expireDomainClaims(runtime:Runtime,deadline:number) {
  // Revisit exclusive claims whose ownership has not been observed for a week, including disconnected claims, so a miss
  // is noticed within a week. The first definite miss starts a 30-day grace period; only a second definite miss after it
  // releases the namespace (what the DOMAIN_CLAIMED refusal tells the domain's owner, domain-claims.ts domainClaimed).
  const due = sql`dc.ever_proven AND dc.claim_scope <> 'account' AND NOT coalesce(dc.identity ?| array['adopted','builtin'], false)
    AND (dc.connection_id IS NULL OR pc.id IS NOT NULL)
    AND CASE WHEN dc.receiving_proof_missed_at IS NULL THEN coalesce(dc.receiving_proved_at, dc.created_at) <= now() - interval '7 days'
      ELSE dc.receiving_proof_missed_at <= now() - interval '30 days' END`;
  let released=0;
  // Expired claims first: a due claim whose authority keeps failing must never hold back their cleanup.
  for (const pending of [sql`domain_claim_expired(dc)`, sql`(${due})`]) {
    let cursor:{created:string;token:string}|undefined;
    while (Date.now()<deadline) {
      const after=cursor ? sql`AND (dc.created_at,dc.token)>(${cursor.created}::timestamptz,${cursor.token}::uuid)` : sql``;
      let selected=false;
      try {
        const found=await runtime.db.transaction(async db=>{
          const row=(await db.execute<{workspace_id:string;name:string;token:string;created:string;expired:boolean;missed:boolean;imported:boolean;connection:(HostedDomain['connection'] & {region:string})|null}>(sql`
            SELECT dc.workspace_id,dc.name,dc.token,dc.created_at::text AS created,domain_claim_expired(dc) AS expired,dc.receiving_proof_missed_at IS NOT NULL AS missed,
              coalesce(dc.identity ? 'imported',false) AS imported,to_jsonb(pc) AS connection FROM domain_claims dc
            LEFT JOIN domain_sending_bindings b ON b.workspace_id=dc.workspace_id AND b.name=dc.name AND b.connection_id=dc.connection_id
            LEFT JOIN regional_connections pc ON pc.id=b.connection_id AND pc.region=b.region
            WHERE ${pending} ${after} ORDER BY dc.created_at,dc.token LIMIT 1 FOR UPDATE OF dc SKIP LOCKED`)).rows[0];
          if (!row) return false;
          cursor=row; selected=true;
          if (!row.expired) {
            const connection = row.connection;
            const identityHeld = async () => {
              if (!connection) return false;
              const scoped = {...runtime, config: {...runtime.config, workspaceId: row.workspace_id, regions: [connection.region]}};
              const client = await getSes(scoped, connection.region, {...connection, identitySession: {name: row.name, purpose: row.imported ? 'read' : 'verify'}});
              try {
                const identity = await sesCall(({GetEmailIdentityCommand}) => client.send(new GetEmailIdentityCommand({EmailIdentity: row.name})));
                if (identity.VerificationStatus === 'TEMPORARY_FAILURE') throw dnsUnavailable(); // SES could not read DNS: no answer either way.
                return identity.VerificationStatus === 'SUCCESS' && (row.imported || ownsIdentity(identity, row.token));
              } catch (e) {
                if (!(e instanceof ApiError) || e.code !== 'SES_IDENTITY_NOT_FOUND') throw e;
                return false;
              }
            };
            const proven = connection?.kind === 'byo' ? await identityHeld() : await ownershipTxt(row.name, row.token);
            if (proven || !row.missed) {
              await db.execute(sql`UPDATE domain_claims SET ${observeProof(proven)} WHERE token=${row.token}`);
              return 'observed';
            }
            // A shared claim's TXT is only needed to verify; sending afterwards rests on its DKIM records. While SES still
            // verifies the claim's tagged identity the name is in use: keep it and look again after another grace period.
            // receiving_proved_at stays as old as the last TXT seen, so this never lets the domain receive.
            if (connection?.kind === 'shared' && await identityHeld()) {
              await db.execute(sql`UPDATE domain_claims SET receiving_proof_missed_at=now() WHERE token=${row.token}`);
              return 'observed';
            }
          }
          if (row.connection?.kind==='shared') await deleteClaimIdentity(runtime,row.workspace_id,{...row,region:row.connection.region,connection:row.connection});
          await releaseClaim(db,row.workspace_id,row);
          // A proven name the workspace held is gone: its owners and admins are told (an abandoned setup is not).
          if (!row.expired) await (await wrapModuleLoad(() => import('../account-notices.js'))).domainReleased(db,row.workspace_id,{name:row.name,token:row.token});
          return true;
        });
        if (!found) break;
        if (found === true) released++;
      } catch (e) {
        if (e instanceof ModuleLoadError || !selected || !(e instanceof ApiError)) throw e;
        log('warn',{code:'DOMAIN_EXPIRY_RETRY',reason:e.code});
      }
    }
  }
  return released;
}
/**
 * While a receiving host waits for its MX, the domain's DNS-only check (domain.mx) runs again soon, not at the next hourly
 * sweep: a host added and published minutes later stayed "MX missing" for over half an hour, and the inbound check didn't
 * look at it at all. Queued when a host is added and by every check on request; each run that still finds a host waiting
 * defers itself (FOLLOW_MX), then the hourly sweep takes over. A run already under way is left to finish.
 */
export const FOLLOW_MX = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 900_000, 900_000, 900_000, 900_000, 900_000];
export const followMxJob = (wid: string, source: SQL) => sql`INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'domain.mx:'||r.token,'domain.mx',${wid},
  jsonb_build_object('domainId',r.id,'token',r.token,'follow',0) FROM (${source}) r
  ON CONFLICT(id) DO UPDATE SET status='pending',available_at=now(),attempts=0,payload=excluded.payload,lease_until=NULL,last_error=NULL,created_at=now() WHERE jobs.status<>'running' RETURNING id`;
export function recheckJob(wid: string, source: SQL, mode:'manual'|'dashboard'|'supersede'='manual') {
  // A recovered creation or MAIL FROM change supersedes even a running poll based on an older SES read.
  // Dashboard reads only advance the due time. Preserve the background poll count and use the job's
  // existing enqueue timestamp as an atomic per-claim cooldown, shared by every tab and isolate.
  return sql`INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'domain.verify:'||r.token,'domain.verify',${wid},
    jsonb_build_object('domainId',r.id,'token',r.token${mode==='dashboard' ? sql`,'dashboard',true` : sql``}) FROM (${source}) r ON CONFLICT(id) DO UPDATE SET status='pending',available_at=now(),lease_until=NULL,last_error=NULL,
    payload=${mode==='dashboard' ? sql`CASE WHEN jobs.status='pending' AND jobs.available_at<=now() THEN jobs.payload ELSE jobs.payload||'{"dashboard":true}'::jsonb END` : sql`excluded.payload`},created_at=clock_timestamp() ${mode==='supersede' ? sql`` : sql`WHERE jobs.status<>'running'`}
    ${mode==='dashboard' ? sql`AND jobs.created_at<=clock_timestamp()-interval '20 seconds'` : sql``} RETURNING id`;
}
export const domainVerify: JobHandler = async (runtime,payload,job) => {
  if (!runtime.config.multiTenant || typeof payload.domainId!=='string') return;
  // A cutover job can arrive at the old consumer. Keep it pending, without consuming a retry or touching SES.
  if (payload.platformAccount && payload.platformAccount!==runtime.config.platformAccount) throw new JobDeferred(new Date(Date.now()+60_000).toISOString(),payload);
  const row=await hostedDomain(runtime.db,job.workspaceId,payload.domainId);
  if (!row || row.token!==payload.token || row.expired) return; // Deleted, reclaimed, disconnected or awaiting expiry cleanup.
  if (row.identity?.builtin) return; // Proven by its parent identity (builtin-domain.ts), never by DNS of its own.
  assertSharedAccount(runtime,row.connection);
  // Only previously proven claims keep polling beyond 72 hours (including recovery after lost proof).
  const poll=Number(payload.poll ?? 0);
  const {dashboard,...background}=payload, nextPoll=dashboard===true && !row.ever_proven ? poll : poll+1;
  const backoff=(n:number)=>n<5 ? [15000,30000,120000,600000,1800000][n]! : n<72 ? 3600_000 : n<84 ? 6*3600_000 : 24*3600_000;
  const defer=(ms:number,next?:number) => {
    const now=Date.now();
    if (!row.ever_proven) {
      const remaining=new Date(row.created_at).getTime()+72*3600_000-now;
      ms=Math.min(ms,3600_000);
      if (remaining>60_000 && ms>=remaining) ms=remaining-30_000;
    }
    // Lane contention isn't an observation. Consume the dashboard nudge only after an actual check.
    throw new JobDeferred(new Date(now+ms).toISOString(),next===undefined ? payload : {...background,poll:next});
  };
  const scoped={...runtime,config:{...runtime.config,workspaceId:job.workspaceId,regions:[row.region]}};
  try {
    if(row.dns_first && !row.ever_proven) {
      if(!await ownershipTxt(row.name,row.token)) defer(backoff(poll),nextPoll);
      await runtime.db.transaction(async db=>{
        await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(substring(${row.name} FROM '[^.]+\\.[^.]+$'),84912))`);
        const elected=await db.execute(sql`UPDATE domain_claims dc SET ever_proven=true WHERE token=${row.token} AND connection_id=${row.connection.id} AND NOT domain_claim_expired(dc) RETURNING token`);
        if (!elected.rowCount) return;
        // Only remove a superseded, tag-matching *platform* identity in the
        // same account and region. Never adopt by name or delete BYO resources.
        const losers=await db.execute<{workspace_id:string;token:string;connection:HostedDomain['connection']}>(sql`SELECT dc.workspace_id,dc.token,to_jsonb(pc) AS connection FROM domain_claims dc JOIN domain_sending_bindings b USING(workspace_id,name,connection_id) JOIN regional_connections pc ON pc.id=b.connection_id AND pc.region=b.region WHERE dc.superseded AND NOT dc.dns_first AND dc.name=${row.name} AND pc.kind='shared' AND pc.region=${row.region} AND pc.aws_account_id=${row.connection.aws_account_id} FOR UPDATE OF dc`);
        for(const loser of losers.rows){await deleteClaimIdentity(runtime,loser.workspace_id,{...row,...loser});await releaseClaim(db,loser.workspace_id,loser);}
      });
      defer(1000,nextPoll); // reload the winning token/binding before creating SES resources
    }
    if (row.connection.kind==='byo' && row.connection.legacy===false && !await byoEnabled(runtime,job.workspaceId)) defer(300_000);
    await Promise.all([
      preloadSesTransport(runtime.config.multiTenant),
      loadOperationsSesv2(),
      loadRegistries(),
      ...(row.connection.kind==='byo' ? [wrapModuleLoad(() => import('../mailbox-setup.js'))] : []),
    ]);
    // Reserve the next GetEmailIdentity across workers, not per workspace or per invocation.
    const lane='domain.verify:'+(row.connection.kind==='shared'?'platform':row.connection.aws_account_id);
    if (!(await runtime.db.execute(sql`INSERT INTO job_schedule(workspace_id,wake_not_before) VALUES (${lane},clock_timestamp()+interval '1 second') ON CONFLICT(workspace_id)
      DO UPDATE SET wake_not_before=excluded.wake_not_before WHERE job_schedule.wake_not_before<=clock_timestamp() RETURNING 1`)).rowCount) {
      defer(1000+Math.random()*1000);
    }
    const client=await getSes(scoped,row.region,{...row.connection,identitySession:{name:row.name,purpose:row.identity?.imported?'read':'verify'}});
    let identity: GetEmailIdentityCommandOutput | undefined;
    try { identity=await sesCall(({ GetEmailIdentityCommand })=>client.send(new GetEmailIdentityCommand({EmailIdentity:row.name}))); }
    catch (e) {
      const ses=row.identity?.ses,reset=row.connection.kind==='shared' && !row.identity?.adopted && !row.identity?.imported && !ses?.VerifiedForSendingStatus &&
        (!ses?.VerificationStatus || ['PENDING','NOT_STARTED'].includes(ses.VerificationStatus)) && (!ses?.DkimAttributes?.Status || ses.DkimAttributes.Status==='NOT_STARTED');
      if (!(e instanceof ApiError) || e.code!=='SES_IDENTITY_NOT_FOUND' || row.identity && !reset) throw e;
    }
    // Recover an interrupted create, including a lost create acknowledgement before feedback forwarding was disabled.
    if (!identity || (!row.identity && identity.FeedbackForwardingStatus === true && ownsIdentity(identity,row.token))) {
      const recovered=await recoverIdentity(runtime,job.workspaceId,row.id,row.token,client);
      if (!recovered) return;
      identity??={...recovered,VerificationStatus:'PENDING',$metadata:{}};
    }
    else if (row.identity?.adopted) {
      // Runtime IAM intentionally denies membership reads/writes on these ARNs. An SES send
      // requires the pinned tenant; only the migration operator can attest membership anew.
      const verified=matchesAdoption(identity,row.identity.adopted.fingerprint);
      if (!platformClaim(runtime.config,job.workspaceId,row)) {
        if (!verified) await runtime.db.execute(sql`UPDATE domain_claims SET sending_state='pending',lost_since=NULL WHERE workspace_id=${job.workspaceId} AND token=${row.token} AND connection_id=${row.connection.id}`);
        return;
      }
      // The platform domain also receives. The operator's attestation, which SES keeps current by checking the
      // platform's own DKIM records, stands in for the claim tag and the ownership TXT; the MX checks are the ordinary
      // ones. A drifted identity stops sending and receiving at once (no grace) until the operator attests it again,
      // and a claim whose adoption never completed (sending still pending) never receives.
      const ses=sesFacts(identity);
      const [dmarc,observation]=await Promise.all([tryObserveDmarc(row.name,identity.MailFromAttributes?.MailFromDomain),receivingMx(runtime.db,row,job.workspaceId)]);
      await runtime.db.transaction(async db=>{
        const current=await hostedDomain(db,job.workspaceId,row.id,true);
        if (!current?.identity?.adopted || current.token!==row.token || current.expired) return;
        // A newer MX observation, or an operator re-attestation made while SES was read, wins over this read.
        if (current.receiving_host!==row.receiving_host || current.identity.adopted.fingerprint!==row.identity!.adopted!.fingerprint) defer(5000);
        const attested=verified && sends(current);
        await db.execute(sql`UPDATE domain_claims SET ${observeProof(attested)},receiving_identity_at=CASE WHEN ${verified} THEN now() END WHERE workspace_id=${job.workspaceId} AND token=${row.token} AND connection_id=${current.connection.id}`);
        await saveObservation(db,current,job.workspaceId,ses,observation,{sending:attested,sendingRevoked:!verified,identityVerified:verified,proven:attested},dmarc);
      });
      return;
    }
    else if (!(row.connection.kind==='byo' && row.identity?.imported) && !ownsIdentity(identity,row.token)) throw unavailableDomain();
    const shared=row.connection.kind==='shared';
    const identityVerified=identity.VerificationStatus==='SUCCESS';
    const scopedImport=row.claim_scope==='account';
    // Don't seed the resolver's negative cache before the user has published DNS. Once ownership
    // is established, keep checking it even if DKIM regresses: receive-only routing has its own grace.
    const dkimSuccess=identity.DkimAttributes?.Status==='SUCCESS';
    const checkHostedTxt=row.check_txt || dkimSuccess || row.identity?.proven || sends(row) || row.receiving_host!==null;
    const [positive,dmarc,observation,upgrade]=await Promise.all([shared ? (checkHostedTxt ? ownershipTxt(row.name,row.token) : false) : identityVerified,tryObserveDmarc(row.name,identity.MailFromAttributes?.MailFromDomain),
      scopedImport || row.connection.legacy===false ? undefined : receivingMx(runtime.db,row,job.workspaceId),scopedImport ? ownershipTxt(row.name,row.token).catch(()=>false) : false]); // Optional ownership lookup never blocks applying SES's sending evidence.
    const report=readiness(row,identity,claimProof(row,positive));
    // The identity binds to the workspace tenant, which the tenant job owns; a verified domain waits for it here.
    if (shared && report.ready && row.connection.tenant_state!=='ready') {
      // Platform setup delay is not a failure to prove ownership.
      await runtime.db.execute(sql`UPDATE domain_claims dc SET ever_proven=true WHERE dc.token=${row.token} AND dc.connection_id=${row.connection.id} AND NOT dc.ever_proven AND NOT domain_claim_expired(dc)
        ${runtime.config.platformAccount ? sql`AND EXISTS(SELECT FROM provider_connections c WHERE c.id=dc.connection_id AND (c.aws_account_id IS NULL OR c.aws_account_id=${runtime.config.platformAccount}))` : sql``}`);
      log('info',{code:'TENANT_NOT_READY',workspaceId:job.workspaceId,domain:row.name}); defer(backoff(poll),nextPoll);
    }
    const outcome=await runtime.db.transaction(async db=>{
      if (upgrade) await db.execute(sql`SELECT promote_imported_claim(${job.workspaceId},${row.name},${row.token},${row.connection.id})`);
      // Serialize the association with deletion: a stale verifier cannot bind a replacement identity.
      const current=await hostedDomain(db,job.workspaceId,row.id,true);
      if (!current || current.token!==row.token || current.expired) return null;
      assertSharedAccount(runtime,current.connection); // The account may have changed during the AWS/DNS read.
      const mailFrom=(facts:IdentityFacts|null)=>facts?.ses.MailFromAttributes?.MailFromDomain ?? null, mailFromStatus=(facts:IdentityFacts|null)=>facts?.ses.MailFromAttributes?.MailFromDomainStatus ?? null;
      if (current.receiving_host!==row.receiving_host || mailFrom(current.identity)!==mailFrom(row.identity) || (mailFromStatus(current.identity)==='PENDING' &&
        (mailFromStatus(row.identity)!=='PENDING' || mailFrom(current.identity)!==report.mailFromDomain))) {
        defer(5000); // The newer configuration has its own poll; never replace it with a stale observation.
      }
      if (shared && report.ready && !sends(current)) {
        const binding=identityBinding(current,job.workspaceId);
        const exclusive=async()=>{
          const page=await sesCall(({ ListResourceTenantsCommand })=>client.send(new ListResourceTenantsCommand({ResourceArn:binding.ResourceArn,PageSize:2})));
          if (!page.ResourceTenants || page.NextToken || page.ResourceTenants.length>1 || page.ResourceTenants.some(t=>t.ResourceArn!==binding.ResourceArn || t.TenantName!==binding.TenantName)) throw unavailableDomain();
          return page.ResourceTenants.length===1;
        };
        const trusted=!!current.connection.pool_tenant_name && current.region==='us-east-1';
        if (!trusted || !await exclusive()) {
          try { await sesCall(({ CreateTenantResourceAssociationCommand })=>client.send(new CreateTenantResourceAssociationCommand(binding))); }
          catch (e) { if (!(e instanceof ApiError) || e.code!=='SES_IDENTITY_EXISTS') throw e; }
          if (trusted && !await exclusive()) defer(5000);
        }
      }
      await db.execute(sql`UPDATE domain_claims SET ${observeProof(positive)}, receiving_identity_at=CASE WHEN ${current.connection.legacy===false} THEN receiving_identity_at WHEN ${identityVerified} THEN now() END WHERE workspace_id=${job.workspaceId} AND token=${row.token} AND connection_id=${current.connection.id}`);
      return saveObservation(db,current,job.workspaceId,sesFacts(identity),observation,{sending:report.ready,sendingRevoked:current.identity?.imported && !report.ready,identityVerified,proven:positive},dmarc);
    });
    // A domain that has never had a DMARC answer (the resolver failed) retries soon, after its verification has committed.
    if (outcome && dmarc===undefined && row.identity?.dmarc===undefined) throw dnsUnavailable();
    if (!outcome || (outcome.sending_state==='verified' && report.mailFromStatus!=='PENDING' && outcome.receiving_state!=='lost')) return; // MX-only upkeep owns receiving changes after sending verifies.
    // DKIM just propagated. Give a lagging TXT its own short retry sequence instead of inheriting
    // the hours-long DKIM backoff. A domain abandoned at this step still backs off normally.
    if (shared && dkimSuccess && row.identity?.ses.DkimAttributes?.Status!=='SUCCESS' && !positive) defer(backoff(0),1);
    // A grace period must be observed again before it can expire.
    if (outcome.sending_state==='lost' || outcome.receiving_state==='lost') defer(Math.min(backoff(poll),LOST_GRACE_MS),nextPoll);
  } catch (e) {
    if (e instanceof ModuleLoadError) throw e;
    if (e instanceof ApiError && ['SES_IDENTITY_NOT_FOUND','DOMAIN_UNAVAILABLE'].includes(e.code)) {
      await runtime.db.transaction(async db=>{
        const current=await hostedDomain(db,job.workspaceId,row.id,true);
        if (current?.token!==row.token) return;
        assertSharedAccount(runtime,current.connection);
        const ses=current.identity?.ses ?? {VerificationStatus:'PENDING'};
        const reset:IdentityFacts['ses']={...ses,VerificationStatus:'PENDING',VerifiedForSendingStatus:false,DkimAttributes:ses.DkimAttributes && {...ses.DkimAttributes,Status:'NOT_STARTED',SigningEnabled:false},MailFromAttributes:undefined};
        await saveObservation(db,current,job.workspaceId,reset,undefined,{sending:false,identityVerified:false,proven:false,unavailable:e.code==='DOMAIN_UNAVAILABLE',definitive:true});
      });
      if (e.code==='DOMAIN_UNAVAILABLE') return;
    } else if (e instanceof ApiError && e.code==='DOMAIN_DNS_UNAVAILABLE') {
      // Transport failures never count as evidence against a working domain.
      defer(Math.min(3_600_000,30_000*2**Math.min(poll,7)),nextPoll);
    } else if (!(e instanceof ApiError) || !e.retryable) {await identityQuotaAlert(runtime,row.region,row.connection.aws_account_id,e);throw e;}
  }
  defer(backoff(poll),nextPoll);
};
export const domainMx:JobHandler=async(runtime,payload,job)=>{
  if (!runtime.config.multiTenant || typeof payload.domainId!=='string') return;
  const row=await hostedDomain(runtime.db,job.workspaceId,payload.domainId);
  if (!row?.identity || row.token!==payload.token || row.identity.builtin) return;
  assertSharedAccount(runtime,row.connection);
  const checkReceiving=row.connection.legacy!==false && row.receiving_state!=='off';
  // undefined preserves the locked row's last observation and its original expiry.
  // A definitive missing/invalid/ambiguous answer must still replace it.
  // An adopted claim never publishes an ownership TXT: its proof is the operator's attestation, renewed by domain.verify.
  const [observation,dmarc,proof]=await Promise.all([checkReceiving ? receivingMx(runtime.db,row,job.workspaceId) : undefined,tryObserveDmarc(row.name,row.identity.ses.MailFromAttributes?.MailFromDomain), row.connection.kind==='shared' && !row.identity.adopted && (checkReceiving || row.receiving_host) ? ownershipTxt(row.name,row.token) : undefined]);
  if(!observation && dmarc===undefined) throw dnsUnavailable();
  // A sending promotion to Virginia doesn't move the existing Ohio ingress. Re-attest the
  // original account/host in Ohio; a successful Virginia SES read is not evidence for it.
  let retainedIdentity:boolean|undefined;
  if(row.connection.kind==='shared' && row.connection.legacy===false && row.receiving_host && row.region!=='us-east-2'){
    const due=await runtime.db.execute(sql`SELECT FROM domain_claims dc JOIN mailbox_domains m ON m.workspace_id=dc.workspace_id AND m.domain_id=${row.id} AND m.region='us-east-2' AND m.status='active' AND m.receiving_host=dc.receiving_host WHERE dc.workspace_id=${job.workspaceId} AND dc.token=${row.token} AND coalesce(dc.receiving_identity_at,'-infinity')<now()-interval '24 hours'`);
    if(due.rowCount){
      if(!(await runtime.db.execute(sql`INSERT INTO job_schedule(workspace_id,wake_not_before) VALUES('domain.verify:platform',clock_timestamp()+interval '1 second') ON CONFLICT(workspace_id) DO UPDATE SET wake_not_before=excluded.wake_not_before WHERE job_schedule.wake_not_before<=clock_timestamp() RETURNING 1`)).rowCount)throw new JobDeferred(new Date(Date.now()+1500).toISOString());
      const client=await getSes({...runtime,config:{...runtime.config,regions:['us-east-2']}},'us-east-2',{...row.connection,identitySession:{name:row.name,purpose:'verify'}});
      try{const identity=await sesCall(({GetEmailIdentityCommand})=>client.send(new GetEmailIdentityCommand({EmailIdentity:row.name})));retainedIdentity=identity.VerificationStatus==='SUCCESS' && !!ownsIdentity(identity,row.token);}
      catch(e){if(!(e instanceof ApiError) || e.code!=='SES_IDENTITY_NOT_FOUND')throw e;retainedIdentity=false;}
    }
  }
  await runtime.db.transaction(async db=>{
    const current=await hostedDomain(db,job.workspaceId,row.id,true);
    if (!current?.identity || current.token!==row.token || current.receiving_host!==row.receiving_host) return;
    assertSharedAccount(runtime,current.connection);
    if(proof!==undefined) await db.execute(sql`UPDATE domain_claims SET ${observeProof(proof)} WHERE workspace_id=${job.workspaceId} AND token=${row.token} AND connection_id=${row.connection.id}`);
    if(retainedIdentity!==undefined)await db.execute(sql`UPDATE domain_claims SET receiving_identity_at=CASE WHEN ${retainedIdentity} THEN now() END WHERE workspace_id=${job.workspaceId} AND token=${row.token} AND connection_id=${row.connection.id}`);
    // Never grant receiving rights (notably to a Virginia sending binding) from a DMARC check.
    if(!observation) { await db.execute(sql`UPDATE domain_claims SET identity=jsonb_set(identity,'{dmarc}',${JSON.stringify(dmarc)}::jsonb) WHERE workspace_id=${job.workspaceId} AND name=${current.name} AND token=${current.token}`); return; }
    // Without NIGHTMAIL_PLATFORM_DOMAIN_WORKSPACE nothing renews the platform attestation: receiving ends with the usual proof grace.
    const attested=!current.identity.adopted || platformClaim(runtime.config,job.workspaceId,current);
    await saveObservation(db,current,job.workspaceId,current.identity.ses,observation,{sending:undefined,identityVerified:current.identity.ses.VerificationStatus==='SUCCESS',proven:proof??(current.identity.proven && attested)},dmarc);
  });
  // A host still waiting for its MX is looked at again soon (followMxJob), until the follow-ups run out.
  const follow=typeof payload.follow==='number' ? payload.follow : null;
  if(observation && follow!==null && follow<FOLLOW_MX.length && (await runtime.db.execute(sql`SELECT 1 FROM mailbox_domains m WHERE m.workspace_id=${job.workspaceId} AND m.status='waiting_for_mx'
    AND (m.domain_id=${row.id} OR m.parent_id IN (SELECT o.id FROM mailbox_domains o WHERE o.workspace_id=${job.workspaceId} AND o.domain_id=${row.id} AND o.parent_id IS NULL)) LIMIT 1`)).rowCount)
    throw new JobDeferred(new Date(Date.now()+FOLLOW_MX[follow]!).toISOString(),{...payload,follow:follow+1});
  if(dmarc===undefined) throw dnsUnavailable(); // Retry after committing any independent MX change.
};

export async function account(runtime: Runtime, wid: string, requested?: string) {
  assertSesConfigured(runtime);
  const connection=runtime.config.multiTenant ? await workspaceConnection({...runtime,config:{...runtime.config,workspaceId:wid}},requested) : undefined;
  if (connection?.kind==='shared') throw new ApiError(403,'SHARED_ACCOUNT_PRIVATE','Account-wide SES settings are not available on hosted mail.');
  const selectedRegion=connection?.template_version==='v5' && !requested ? (await getRegionSettings(runtime.db,wid)).defaultRegion : connection?.region ?? requested ?? runtime.config.regions[0]!;
  if (connection) runtime={...runtime,config:{...runtime.config,workspaceId:wid,regions:[selectedRegion]}};
  const a = await sesCall(async ({ GetAccountCommand }) => (await getSes(runtime, selectedRegion,forDelivery(connection,{purpose:'quota'}))).send(new GetAccountCommand({}))); return { region: selectedRegion, productionAccess: a.ProductionAccessEnabled === true, sendingEnabled: a.SendingEnabled === true, enforcementStatus: a.EnforcementStatus ?? 'UNKNOWN', quota: { max24HourSend: a.SendQuota?.Max24HourSend ?? 0, maxSendRate: a.SendQuota?.MaxSendRate ?? 0, sentLast24Hours: a.SendQuota?.SentLast24Hours ?? 0 } }; }

/** listDomains' own checks (the notMember path guard runs first): read permission and, self-hosted, a configured region with live SES. */
export function domainReader(c: Ctx, requested?: string) {
  const a = actor(c);
  if (!c.env.config.multiTenant) { region(c.env, requested ?? c.env.config.regions[0]!); assertSesConfigured(c.env); }
  return a;
}
type DomainQuery = { limit: number; region?: string; refresh: 'true' | 'false'; cursor?: string; /** The caller counts the quota in a statement of its own (getOverviewSetup). */ countedElsewhere?: boolean };
/** One page of domains as listDomains returns it. Hosted: one statement. Self-hosted: two with refresh=false, otherwise one plus an SES read per domain. */
export async function domainPage(c: Ctx, a: Actor, q: DomainQuery): Promise<z.infer<typeof DomainPage>> {
  const page = await domainRows(c, a, q);
  // Each domain's link record (src/link-domains.ts), so Overview's domains are listDomains' own.
  await withLinkRecords(c.env, a.workspaceId, page.data);
  return page;
}
async function domainRows(c: Ctx, a: Actor, q: DomainQuery): Promise<z.infer<typeof DomainPage>> {
  const allowed = a.domains.length ? or(...a.domains.map(parent => or(eq(domains.name, parent), like(domains.name, `%.${parent}`)))) : undefined;
  const where = and(scoped(domains, a), allowed, q.region ? eq(domains.region, region(c.env, q.region)) : c.env.config.multiTenant ? undefined : inArray(domains.region, c.env.config.regions), q.cursor ? lt(domains.id, q.cursor) : undefined);
  if (c.env.config.multiTenant) {
    const [rows,quota]=await Promise.all([c.env.db.select({row:domains,hosts:sql<ReceivingHostRow[]>`${domainHosts(sql`${domains}`)}`,token:domainClaims.token,proof_label:domainClaims.proofLabel,claim_scope:domainClaims.claimScope,sending_state:domainClaims.sendingState,receiving_state:domainClaims.receivingState,receiving_host:domainClaims.receivingHost,receiving_proved_at:sql<string>`domain_claims.receiving_proved_at`,receiving_identity_at:sql<string>`domain_claims.receiving_identity_at`,receiving_proof_missed_at:sql<string>`domain_claims.receiving_proof_missed_at`,lost_since:domainClaims.lostSince,receiving_lost_since:domainClaims.receivingLostSince,identity:domainClaims.identity,created_at:domainClaims.createdAt,ever_proven:domainClaims.everProven,setup_check:sql<SetupCheck|null>`domain_claims.setup_check`,kind:sql<'shared'|'byo'>`pc.kind`,legacy:sql<boolean>`pc.legacy`}).from(domains)
      .innerJoin(domainClaims,and(eq(domainClaims.name,domains.name),eq(domainClaims.workspaceId,domains.workspaceId)))
      .innerJoin(sql`regional_connections pc`,sql`pc.id=${domainClaims.connectionId} AND pc.workspace_id=${domains.workspaceId} AND pc.region=${domains.region} AND ${connectionReady()}`)
      .where(where).orderBy(desc(domains.id)).limit(q.limit+1),a.domains.length || q.countedElsewhere ? undefined : domainQuota(c.env.db,a.workspaceId)]);
    return {data:rows.slice(0,q.limit).map(r=>derivedReadiness({...r,...r.row,connection:{kind:r.kind,legacy:r.legacy}},c.env.config)),nextCursor:rows.length>q.limit?rows[q.limit-1]!.row.id:null,...quota && quota.limit !== null ? {quota:{used:quota.used,limit:quota.limit}} : {}};
  }
  const rows = await c.env.db.select({row:domains,mx:mailboxDomains.mx,status:mailboxDomains.status}).from(domains).leftJoin(mailboxDomains,and(eq(mailboxDomains.workspaceId,domains.workspaceId),eq(mailboxDomains.domainId,domains.id),isNull(mailboxDomains.parentId))).where(where).orderBy(desc(domains.id)).limit(q.limit + 1);
  if (q.refresh === 'false') {
    const reports = await c.env.db.select({ region: sesRegions.region, report: sesRegions.report }).from(sesRegions).where(eq(sesRegions.workspaceId, a.workspaceId));
    const data = rows.slice(0, q.limit).map(({row,mx,status}) => {
      const cached = reports.find(report => report.region === row.region)?.report?.domains.find(domain => domain.name === row.name);
      const ready = cached?.verificationStatus === 'SUCCESS' && cached.sendingEnabled === true, verified = cached?.sendingEnabled === true;
      return { ...readiness(row,{},undefined,mx),verificationStatus: cached?.verificationStatus ?? 'NOT_STARTED', verified, dkimStatus: ready ? 'SUCCESS' : 'NOT_STARTED', ready,sending:state(ready),receiving:state(status==='active' && mx?.state==='active' && verified),dnsUnavailableReason: 'Open the domain to refresh DNS details.' };
    });
    return { data, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.row.id : null };
  }
  const data: z.infer<typeof domainSchema>[] = [];
  for (const {row,mx,status} of rows.slice(0, q.limit)) {
    if (data.length) await new Promise(resolve => setTimeout(resolve, 1000));
    const identity=await sesCall(async ({ GetEmailIdentityCommand })=>(await getSes(c.env,row.region)).send(new GetEmailIdentityCommand({ EmailIdentity:row.name })));
    const report=readiness(row,identity,undefined,mx,undefined,await localDmarc(row.name,identity.MailFromAttributes?.MailFromDomain));if(status!=='active')report.receiving='pending';data.push(report);
  }
  return { data, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.row.id : null };
}

/** Every domain a domain route returns, with its link record after its sending records (src/link-domains.ts): one read
 *  per response, while link hosts are on for the workspace. It is not part of whether a domain is ready, so no route's own logic needs it. */
export const domainLinkRecords = async (c: Ctx, next: () => Promise<void>) => {
  await next();
  const workspaceId = c.get('actor')?.workspaceId;
  if (!c.env.config || !workspaceId || !ownLinkHosts(c.env.config, workspaceId) || c.res.status >= 300 || !c.res.headers.get('content-type')?.startsWith('application/json')) return;
  const body = await c.res.clone().json().catch(() => null) as { name?: unknown; dns?: unknown; data?: unknown } | null;
  const domainLike = (value: unknown): value is { name: string; dns: Parameters<typeof withLinkRecords>[2][number]['dns'] } => typeof (value as { name?: unknown })?.name === 'string' && Array.isArray((value as { dns?: unknown }).dns);
  const reports = domainLike(body) ? [body] : Array.isArray(body?.data) ? body.data.filter(domainLike) : [];
  if (!reports.length) return;
  await withLinkRecords(c.env, workspaceId, reports);
  const headers = new Headers(c.res.headers); headers.delete('content-length');
  c.res = new Response(JSON.stringify(body), { status: c.res.status, headers });
};
