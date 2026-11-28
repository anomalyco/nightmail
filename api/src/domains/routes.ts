import { DASHBOARD_CACHE_NOTE, dashboardRead } from '../dashboard-cache.js';
import { talliesEnabled } from '../sending-tallies.js';
import { emailAccepted, emailDelivered, emailBounced, emailComplained, emailHas } from '../email-outcomes.js';
import { auditInsert, auditContext, recordAudit } from '../audit.js';
import { z, createRoute } from '@hono/zod-openapi';
import { sql, and, eq, isNull, gte, lt } from 'drizzle-orm';
import type { GetEmailIdentityCommandOutput } from '@aws-sdk/client-sesv2';
import { actor, lasting, RECEIVING_HOST_CHANGE } from '../core/access.js';
import { ApiError, notFound, denied, errors, wrapModuleLoad, ModuleLoadError } from '../core/errors.js';
import { getSes, preloadSesTransport, assertSesConfigured, region } from '../core/ses.js';
import { security, response, json, PageQuery, id, IdParams, readLimitNote, budgetedRead, readLimit } from '../core/http.js';
import type { Runtime, Ctx, App } from '../core/types.js';
import { identityOnly, type IdentityFacts } from '../states.js';
import { WORKSPACE_FOCUS, type WorkspaceFocus } from '../workspace-focus.js';
import { SETUP_LIMITS, SETUP_SENDER } from '../setup-email.js';
import { emails } from '../db/sending.js';
import { withRegionSettings } from '../ses-region-state.js';
import { claimName, reserveClaim, domainName, reservedPlatformName } from '../domain-claims.js';
import { loadRegistries } from '../domain-registry.js';
import { groupIds, discover, pendingGroups, signedApply, verifyReturn } from '../domain-connect.js';
import { localDmarc } from '../dmarc.js';
import { mailboxDomains } from '../db/mailbox.js';
import { establishedHost, inspectReceivingHost } from '../receiving-host.js';
import { domains } from '../db/operations.js';
import { productName, requestHeaderNames } from '../brand.js';
import { PostalAddress, postalAddressText } from '../outbound-content.js';
import { withLinkRecords, checkLinkHost, forgetLinkHost } from '../link-domains.js';
import { type DomainRef, sesCall, readiness, domainLinkRecords, account, DomainPage, domainPage, domainReader, domainSchema, allowedDomain, type Readiness, noDnsIssue, loadOperationsSesv2, derivedReadiness, recoverIdentity, identityQuotaAlert, releaseClaim, sesFacts, recheckJob, hostedDomain, ownsIdentity, unavailableDomain, dnsUnavailable, hostedDomainSelect, verifyHostedDomain, deleteClaimIdentity, identityJournalEntry } from './hosted.js';
import { workspaceActor, scoped } from '../webhooks/crypto.js';

const RegionalAccepted = z.object({ operationId: z.string(), regions: z.array(z.string()) });
const accountSchema = z.object({ region: z.string(), productionAccess: z.boolean(), sendingEnabled: z.boolean(), enforcementStatus: z.string(), quota: z.object({ max24HourSend: z.number(), maxSendRate: z.number(), sentLast24Hours: z.number() }) }).openapi('SesAccount');
const Focus = z.enum(WORKSPACE_FOCUS);
const FOCUS_NOTE = 'What the workspace is here for, the first leading: marketing emails, a newsletter, developer (transactional) emails, agent inboxes or a personal inbox. The dashboard tailors its first steps and Overview to it. Null until chosen; empty when skipped.';
const settingsSchema = z.object({ name: z.string(), postalAddress: z.string().nullable().describe('The postal address every campaign footer and marketing send shows under Unsubscribe; null until one is set. Campaigns can\'t be sent or scheduled without it.'),
  requiredNotices: z.boolean().describe('Whether campaigns in this workspace may be required notices (requiredNotice), which also reach people who unsubscribed from marketing. Only an operator turns this on.'),
  focus: z.array(Focus).nullable().describe(FOCUS_NOTE) }).openapi('WorkspaceSettings');
const requiredNoticesOf = (workspaceId: string) => sql<boolean>`coalesce((SELECT required_notices FROM workspaces WHERE id=${workspaceId}),false)`;
const regionQuery = z.object({ region: z.string().optional() }).openapi('RegionQuery');
/** The built-in domain (builtin-domain.ts) is the workspace's for good: no DNS, MAIL FROM or receiving host of its own to change. */
const builtinDomainFixed = () => new ApiError(409, 'BUILTIN_DOMAIN', `This is the workspace\u2019s built-in domain. ${productName} manages it, so it can\u2019t be deleted or changed; add a domain of your own instead.`);
async function domainReadiness(runtime: Runtime, row: DomainRef, identity?: GetEmailIdentityCommandOutput, mode:'create'|'read'|'verify'='read') {
  const [stored]=await runtime.db.select({mx:mailboxDomains.mx,status:mailboxDomains.status}).from(mailboxDomains).where(and(eq(mailboxDomains.domainId,row.id),isNull(mailboxDomains.parentId)));
  identity??=await sesCall(async ({ GetEmailIdentityCommand }) => (await getSes(runtime,row.region)).send(new GetEmailIdentityCommand({ EmailIdentity:row.name })));
  const report=readiness(row,identity,undefined,stored?.mx,undefined,mode==='create' ? null : await localDmarc(row.name,identity.MailFromAttributes?.MailFromDomain,mode==='verify'));
  if (stored?.status!=='active') report.receiving='pending';
  return report;
}
function dnsSetupActor(c:Ctx) {
  if (!c.env.config.multiTenant) return notFound('Endpoint');
  const a=actor(c,'manage');
  // A person approves this at their DNS provider: the link is signed for them, and the provider sends their browser back
  // to the dashboard. A key gets the records themselves from the domain, and says so when refused.
  const id=c.req.param('id') ?? '{id}';
  if (a.credential!=='dashboard' || (a.role!=='owner' && a.role!=='admin')) throw denied('PERMISSION_DENIED',`One-click DNS setup is for an owner or admin signed in to the dashboard: it returns a link a person approves at their DNS provider. Every record to publish is in GET /v1/domains/${id} (dns: each record's name, type, value and status). Publish them at the DNS provider, then call POST /v1/domains/${id}/verify to check them now; the domain also re-checks on its own.`,{ permission: 'configuration', level: 'write', credential: 'dashboard', person: 'admin' });
  return a;
}

export function registerDomainsAndSettings(app: App) {
  app.use('/v1/domains', domainLinkRecords); app.use('/v1/domains/*', domainLinkRecords);
  app.openapi(createRoute({ method: 'get', path: '/v1/settings/workspace', operationId: 'getWorkspaceSettings', tags: ['Settings'], security, responses: { 200: response(settingsSchema), ...errors } }), async c => {
    const a = workspaceActor(c); const { rows: [row] } = await c.env.db.execute<{ name: string | null; postal_address: string | null; required_notices: boolean; focus: WorkspaceFocus[] | null }>(c.env.config.multiTenant
      ? sql`SELECT name,postal_address,${requiredNoticesOf(a.workspaceId)} AS required_notices,focus FROM workspaces WHERE id=${a.workspaceId}`
      : sql`SELECT s.name,s.postal_address,${requiredNoticesOf(a.workspaceId)} AS required_notices,s.focus FROM (SELECT) one LEFT JOIN operation_settings s ON s.workspace_id=${a.workspaceId}`);
    return c.json({ name: row?.name ?? productName, postalAddress: row?.postal_address ?? null, requiredNotices: row?.required_notices ?? false, focus: row?.focus ?? null }, 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/settings/workspace', operationId: 'updateWorkspaceSettings', description: 'Change the workspace\'s name, its postal address, its focus, or any of them; omitted fields keep their value. The postal address appears under the Unsubscribe link of every campaign email and marketing send, as US law (CAN-SPAM) requires: campaigns can\'t be sent or scheduled without one (422 POSTAL_ADDRESS_REQUIRED). null removes it. Owners and admins only.', tags: ['Settings'], security,
    request: { body: json(z.object({ name: z.string().trim().min(1).max(120).optional(), postalAddress: PostalAddress.nullable().optional(),
      focus: z.array(Focus).max(WORKSPACE_FOCUS.length).refine(focus => new Set(focus).size === focus.length, 'List each focus once.').nullable().optional().describe(FOCUS_NOTE + ' Order matters: the first leads.') })
      .refine(body => body.name !== undefined || body.postalAddress !== undefined || body.focus !== undefined, 'Send name, postalAddress, focus or any of them.')
      .openapi('UpdateWorkspaceSettings', { example: { postalAddress: 'Example Inc.\n1 Main Street\nSpringfield, IL 62701' } })) }, responses: { 200: response(settingsSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), input = c.req.valid('json');
    // Each line trimmed, empty ones dropped, so the footer shows exactly what was meant.
    const name = input.name ?? null, address = input.postalAddress === undefined ? undefined : input.postalAddress === null ? null : postalAddressText(input.postalAddress);
    const fields = [...input.name !== undefined ? ['name'] : [], ...address !== undefined ? ['postalAddress'] : [], ...input.focus !== undefined ? ['focus'] : []];
    const setAddress = address !== undefined, setFocus = input.focus !== undefined;
    const focus = sql`CASE WHEN ${input.focus ? JSON.stringify(input.focus) : null}::jsonb IS NULL THEN NULL::text[] ELSE ARRAY(SELECT jsonb_array_elements_text(${input.focus ? JSON.stringify(input.focus) : null}::jsonb)) END`;
    const audit = auditInsert(auditContext(c), { action: 'settings.update', workspaceId: a.workspaceId, target: { type: 'workspace', id: a.workspaceId },
      before: sql`(SELECT jsonb_strip_nulls(jsonb_build_object('name',CASE WHEN ${name}::text IS NOT NULL THEN name END,'postalAddress',CASE WHEN ${setAddress}::boolean THEN coalesce(postal_address,'') END,'focus',CASE WHEN ${setFocus}::boolean THEN to_jsonb(focus) END)) FROM old)`,
      after: { ...input.name !== undefined ? { name: input.name } : {}, ...setAddress ? { postalAddress: address ?? '' } : {}, ...setFocus ? { focus: input.focus } : {} }, details: { fields } }, { from: sql`changed` });
    const { rows: [row] } = await c.env.db.execute<{ name: string; postal_address: string | null; required_notices: boolean; focus: WorkspaceFocus[] | null }>(c.env.config.multiTenant
      ? sql`WITH old AS (SELECT name,postal_address,focus FROM workspaces WHERE id=${a.workspaceId}), changed AS (UPDATE workspaces SET name=coalesce(${name}::text,name),
        postal_address=CASE WHEN ${setAddress}::boolean THEN ${address ?? null}::text ELSE postal_address END, focus=CASE WHEN ${setFocus}::boolean THEN ${focus} ELSE focus END
        WHERE id=${a.workspaceId} RETURNING name,postal_address,required_notices,focus), audit AS (${audit}) SELECT * FROM changed`
      : sql`WITH old AS (SELECT name,postal_address,focus FROM operation_settings WHERE workspace_id=${a.workspaceId}), changed AS (INSERT INTO operation_settings(workspace_id,name,postal_address,focus)
        VALUES (${a.workspaceId},coalesce(${name}::text,${productName}),${address ?? null}::text,${focus}) ON CONFLICT ON CONSTRAINT operation_settings_pkey DO UPDATE SET name=coalesce(${name}::text,operation_settings.name),
        postal_address=CASE WHEN ${setAddress}::boolean THEN excluded.postal_address ELSE operation_settings.postal_address END,
        focus=CASE WHEN ${setFocus}::boolean THEN excluded.focus ELSE operation_settings.focus END,updated_at=now() RETURNING name,postal_address,focus), audit AS (${audit}) SELECT *,${requiredNoticesOf(a.workspaceId)} AS required_notices FROM changed`);
    return c.json({ name: row?.name ?? input.name ?? productName, postalAddress: row?.postal_address ?? null, requiredNotices: row?.required_notices ?? false, focus: row?.focus ?? null }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/settings/ses', operationId: 'getSesSettings', tags: ['Settings'], security, request: { query: regionQuery }, responses: { 200: response(accountSchema), ...errors } }), async c => { const a = workspaceActor(c); return c.json(await account(c.env,a.workspaceId,c.req.valid('query').region), 200); });
  app.openapi(createRoute({ method: 'get', path: '/v1/domains', operationId: 'listDomains', description: 'MX returns persisted DNS records and background verification status without AWS calls. Self-hosted installations refresh up to ten identities unless refresh=false.', tags: ['Domains'], security, request: { query: PageQuery.extend({ limit: z.coerce.number().int().min(1).max(10).default(5), region: z.string().optional(), refresh: z.enum(['true', 'false']).default('true') }).openapi('ListDomainsQuery') }, responses: { 200: response(DomainPage), ...errors } }), async c => {
    const q = c.req.valid('query');
    return c.json(await domainPage(c, domainReader(c, q.region), q), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/domains', operationId: 'createDomain', tags: ['Domains'], security, request: { body: json(z.object({ name: claimName, region: z.string().optional().describe('Regional BYO defaults to the first enabled region, otherwise Ohio.') }).openapi('CreateDomain')) }, responses: { 201: response(domainSchema),202:response(RegionalAccepted), ...errors } }), async c => {
    const a = actor(c, 'manage'); const input = c.req.valid('json'); allowedDomain(a, input.name, true);
    // Hosted, one NS lookup beside the claim (two seconds, cached): a name nobody serves DNS for is added all the same,
    // and the answer says so. A resolver error or timeout says nothing. Hosted, it is stored as the domain's first setup check, so
    // reads, Check now and the background check carry it until DNS answers.
    const noDns = c.env.config.domainNsCheck ? wrapModuleLoad(() => import('../record-check.js')).then(m => m.noDnsAt(input.name), () => false) : Promise.resolve(false);
    const created = async (report: Readiness, claimToken?: string) => {
      if (!await noDns) return c.json(report, 201);
      if (claimToken) await c.env.db.execute(sql`UPDATE domain_claims SET setup_check=${JSON.stringify({ checkedAt: new Date().toISOString(), host: null, noDns: true, records: [] })}::jsonb
        WHERE workspace_id=${a.workspaceId} AND token=${claimToken}::uuid AND sending_state='pending' AND setup_check IS NULL`);
      return c.json({ ...report, dnsIssue: noDnsIssue(report.name) }, 201);
    };
    if (c.env.config.multiTenant) {
      const pending=await (await wrapModuleLoad(() => import('../byo-regional.js'))).newRegionalDomain(c.env,a.workspaceId,input.name,a.credential==='dashboard' && (a.role==='owner' || a.role==='admin'),input.region,c.req.header('Idempotency-Key'));
      if (pending) {a.wakeJobs=1;return c.json(pending,202);}
      await Promise.all([preloadSesTransport(true), loadOperationsSesv2(), loadRegistries()]);
      // A new claim and its audit row are one statement; a retried or reconnected claim writes none.
      const claim=await reserveClaim(c.env,a.workspaceId,input.name,input.region,reserved=>auditInsert(auditContext(c),{action:'domain.create',workspaceId:a.workspaceId,target:{type:'domain',id:sql`${reserved}.id`},
        after:sql`jsonb_build_object('name',${input.name}::text,'region',${reserved}.connection->>'region')`},{from:reserved,where:sql`${reserved}.fresh AND ${reserved}.id IS NOT NULL AND ${reserved}.error_code IS NULL`})),
        row={name:input.name,region:claim.connection.region,id:claim.id};
      if (claim.claim.identity) return created(derivedReadiness({...row,...claim.claim,token:claim.token,connection:claim.connection}),claim.token);
      a.wakeJobs=1;
      const runtime={...c.env,config:{...c.env.config,workspaceId:a.workspaceId,regions:[row.region]}};
      // The reservation already queued the verify job, which creates the identity itself if this request dies here.
      let identity: Partial<GetEmailIdentityCommandOutput>|null|undefined;
      try {
        const client=await getSes(runtime,row.region,claim.connection);
        identity=await recoverIdentity(runtime,a.workspaceId,row.id,claim.token,client);
      }
      catch(e) {
        if (e instanceof ModuleLoadError) throw e;
        await identityQuotaAlert(runtime,row.region,claim.connection.aws_account_id,e);
        if (e instanceof ApiError && (e.code==='DOMAIN_UNAVAILABLE' || (claim.fresh && !e.retryable && e.status<500))) await releaseClaim(c.env.db,a.workspaceId,claim);
        throw e;
      }
      if (identity===null) return created(derivedReadiness({...row,...claim.claim,token:claim.token,connection:claim.connection,dns_first:true}),claim.token);
      if (!identity) throw new ApiError(409,'DOMAIN_CLAIM_EXPIRED',`${row.name} was released while it was being set up (its 72-hour ownership window ended, or it was removed). Add it again with POST /v1/domains.`);
      const facts=identityOnly(sesFacts({...identity,VerificationStatus:'PENDING'}));
      // Never overwrite a verifier that already recovered a lost/slow Create response.
      const saved=sql`UPDATE domain_claims SET identity=${JSON.stringify(facts)}::jsonb WHERE token=${claim.token} AND name=${row.name} AND identity IS NULL ${claim.connection.kind==='shared' && runtime.config.platformAccount ? sql`AND EXISTS(SELECT FROM provider_connections c WHERE c.id=connection_id AND (c.aws_account_id IS NULL OR c.aws_account_id=${runtime.config.platformAccount}))` : sql``} RETURNING ${row.id}::text AS id,token`;
      await c.env.db.execute(claim.fresh ? saved : sql`WITH recovered AS (${saved}) ${recheckJob(a.workspaceId,sql`SELECT id,token FROM recovered`,'supersede')}`);
      return created(derivedReadiness({...row,...claim.claim,identity:facts,token:claim.token,connection:claim.connection}),claim.token);
    }
    assertSesConfigured(c.env);
    const body = { name: input.name, region: input.region ?? c.env.config.regions[0]! };
    const client = await getSes(c.env, body.region); let identity: GetEmailIdentityCommandOutput | undefined;
    try { identity = await sesCall(({ GetEmailIdentityCommand }) => client.send(new GetEmailIdentityCommand({ EmailIdentity: body.name }))); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'SES_IDENTITY_NOT_FOUND') throw error;
    }
    if (!identity) {
      try { await sesCall(({ CreateEmailIdentityCommand }) => client.send(new CreateEmailIdentityCommand({ EmailIdentity: body.name, DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' } }))); }
      catch (createError) { if (!(createError instanceof ApiError) || createError.code !== 'SES_IDENTITY_EXISTS') throw createError; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const { rows: [row] } = await c.env.db.execute<DomainRef>(sql`WITH saved AS (INSERT INTO operation_domains(id,workspace_id,name,region)
      VALUES (${id('dom')},${a.workspaceId},${body.name},${body.region}) ON CONFLICT ON CONSTRAINT operation_domain_scope
      DO UPDATE SET updated_at=now() RETURNING id,name,region,xmax=0 AS created),
      audit AS (${auditInsert(auditContext(c),{action:'domain.create',workspaceId:a.workspaceId,target:{type:'domain',id:sql`saved.id`},after:body},{from:sql`saved`,where:sql`saved.created`})})
      SELECT id,name,region FROM saved`);
    return created(await domainReadiness(c.env, row!, identity,'create'));
  });
  // Sets (mailFromDomain) or removes (null) a domain's custom MAIL FROM. Removing it calls SES without a MailFromDomain, which
  // returns the identity to the default amazonses.com MAIL FROM, and drops its MX and SPF records and SPF alignment. Removing
  // a MAIL FROM that isn't set changes nothing.
  async function putMailFrom(c: Ctx, domainId: string, mailFromDomain: string | null) {
    const a = actor(c, 'manage'); const [row] = await c.env.db.select().from(domains).where(and(scoped(domains, a), eq(domains.id, domainId)));
    if (!row) return notFound('Domain'); allowedDomain(a, row.name);
    if (mailFromDomain !== null && (mailFromDomain === row.name || !mailFromDomain.endsWith(`.${row.name}`))) throw new ApiError(422, 'MAIL_FROM_DOMAIN_INVALID', `Use a subdomain of ${row.name}.`, 'mailFromDomain');
    const mailFromAudit = { action: mailFromDomain ? 'domain.mail_from' : 'domain.mail_from_remove', workspaceId: a.workspaceId, target: { type: 'domain', id: row.id }, after: { name: row.name, mailFromDomain } };
    const put = (client: Awaited<ReturnType<typeof getSes>>) => sesCall(({ PutEmailIdentityMailFromAttributesCommand }) => client.send(new PutEmailIdentityMailFromAttributesCommand(mailFromDomain ? { EmailIdentity: row.name, MailFromDomain: mailFromDomain, BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' } : { EmailIdentity: row.name })));
    if (c.env.config.multiTenant) {
      const report=await c.env.db.transaction(async db=>{
        const current=await hostedDomain(db,a.workspaceId,row.id,true) ?? notFound('Domain');
        if (current.identity?.builtin) throw builtinDomainFixed();
        // The receiving host's MX points to inbound-smtp; a MAIL FROM subdomain needs its own MX to feedback-smtp. One name can't hold both.
        const receivingHosts=new Set([...derivedReadiness(current).dns.filter(r=>r.purpose==='receiving').map(r=>r.name),...current.hosts.filter(h=>h.status!=='disabled').map(h=>h.host)]);
        if (mailFromDomain && receivingHosts.has(mailFromDomain)) throw new ApiError(409,'MAIL_FROM_RECEIVING_CONFLICT',`${mailFromDomain} is one of ${row.name}’s receiving hosts, so its MX points to inbound-smtp.${row.region}.amazonaws.com. A custom MAIL FROM subdomain needs its own MX to feedback-smtp.${row.region}.amazonses.com. Use another subdomain, such as email.${row.name}.`);
        const client=await getSes({...c.env,config:{...c.env.config,workspaceId:a.workspaceId,regions:[row.region]}},row.region,{...current.connection,identitySession:{name:row.name,purpose:'mailFrom'}});
        if (current.identity?.imported) throw new ApiError(409,'IMPORTED_IDENTITY_READ_ONLY','Manage this imported identity’s MAIL FROM settings in AWS.');
        const identity=await sesCall(({ GetEmailIdentityCommand })=>client.send(new GetEmailIdentityCommand({EmailIdentity:row.name})));
        if (!ownsIdentity(identity,current.token)) throw unavailableDomain();
        const known=current.identity ?? identityOnly(sesFacts(identity)), ses={...(current.identity?.ses ?? sesFacts(identity))};
        if (!mailFromDomain && !identity.MailFromAttributes?.MailFromDomain && !ses.MailFromAttributes?.MailFromDomain) return derivedReadiness(current);
        await put(client);
        // Changing MAIL FROM is a new fact, not a state change: ownership, sending and routing stay as they are.
        if (mailFromDomain) ses.MailFromAttributes={MailFromDomain:mailFromDomain,MailFromDomainStatus:'PENDING',BehaviorOnMxFailure:'USE_DEFAULT_VALUE'};
        else delete ses.MailFromAttributes;
        const facts:IdentityFacts={...known,ses,...(!mailFromDomain && known.dmarc ? {dmarc:{...known.dmarc,alignedMailFrom:null}} : {})};
        await db.execute(sql`WITH saved AS (UPDATE domain_claims SET identity=${JSON.stringify(facts)}::jsonb WHERE token=${current.token} AND connection_id=${current.connection.id} RETURNING ${current.id}::text AS id,token)
          ${recheckJob(a.workspaceId,sql`SELECT id,token FROM saved`,'supersede')}`);
        await recordAudit(db,c,mailFromAudit);
        return derivedReadiness({...current,identity:facts});
      }); a.wakeJobs=1; return report;
    }
    const client = await getSes(c.env, row.region);
    if (!mailFromDomain) {
      const identity = await sesCall(({ GetEmailIdentityCommand }) => client.send(new GetEmailIdentityCommand({ EmailIdentity: row.name })));
      if (!identity.MailFromAttributes?.MailFromDomain) return domainReadiness(c.env, row, identity);
    }
    // The change is in SES, not in a database row. Fail closed: the audit row is written first and committed only once SES
    // accepted the change, so a change without its row needs a lost commit (the client then sees 500 and retries).
    await c.env.db.transaction(async tx => {
      await recordAudit(tx, c, mailFromAudit);
      await put(client);
    });
    return domainReadiness(c.env, row);
  }
  app.openapi(createRoute({ method: 'post', path: '/v1/domains/{id}/mail-from', operationId: 'configureDomainMailFrom', tags: ['Domains'], security, description: 'Configure a custom SES MAIL FROM subdomain with fallback to the default amazonses.com MAIL FROM value while DNS is unavailable.', request: { params: IdParams, body: json(z.object({ mailFromDomain: domainName }).strict().openapi('ConfigureDomainMailFrom')) }, responses: { 200: response(domainSchema), ...errors } }), async c =>
    c.json(await putMailFrom(c, c.req.valid('param').id, c.req.valid('json').mailFromDomain), 200));
  app.openapi(createRoute({ method: 'delete', path: '/v1/domains/{id}/mail-from', operationId: 'removeDomainMailFrom', tags: ['Domains'], security, description: 'Remove the custom MAIL FROM subdomain. Mail goes back to the default amazonses.com MAIL FROM, and the MAIL FROM MX and SPF records are no longer needed. Removing a MAIL FROM that isn\'t set changes nothing and returns the domain.', request: { params: IdParams }, responses: { 200: response(domainSchema), ...errors } }), async c =>
    c.json(await putMailFrom(c, c.req.valid('param').id, null), 200));
  app.openapi(createRoute({method:'post',path:'/v1/domains/{id}/receiving-host',operationId:'chooseReceivingHost',tags:['Domains'],security,
    description:`Hosted only. Choose a host for this domain to receive on, its root or one of its subdomains. Until the domain receives anywhere, the choice replaces the automatic suggestion (the first of reply., inbound., mail. and so on with no MX and no CNAME), and null returns to it. Once it receives, the chosen host is added beside the hosts it already receives on, as POST /v1/inbound/domains/{id}/hosts does: nothing that receives is moved or stopped. Public DNS is checked first. A CNAME (RFC 1034), one of ${productName}’s own names (custom MAIL FROM, ownership TXT, DKIM), a host another domain receives on (in any workspace), a name another workspace has claimed (send-only included) or a delegated zone (its own NS records) is refused with a free subdomain to use instead. A host whose mail another provider receives, or whose MX is split, needs confirm: true, because publishing ${productName}’s MX moves that mail. A wildcard (*.domain) answer only flags receivingIssue. Nothing changes in DNS or SES.`,
    request:{params:IdParams,body:json(z.object({host:domainName.nullable(),confirm:z.boolean().default(false)}).strict().openapi('ChooseReceivingHost'))},
    responses:{200:response(domainSchema),...errors}}),async c=>{
    const a=actor(c,'manage'); lasting(c,RECEIVING_HOST_CHANGE); if (!c.env.config.multiTenant) return notFound('Endpoint');
    const {host,confirm}=c.req.valid('json'), domainId=c.req.valid('param').id;
    // DNS is read before the row lock; the locked write is fenced on the claim token.
    const row=await hostedDomain(c.env.db,a.workspaceId,domainId) ?? notFound('Domain'); allowedDomain(a,row.name);
    if (row.identity?.builtin) throw builtinDomainFixed();
    if (host!==null && host!==row.name && !host.endsWith(`.${row.name}`)) throw new ApiError(422,'RECEIVING_HOST_INVALID',`Use ${row.name} or one of its subdomains.`,'host');
    if (host!==null && reservedPlatformName(host,c.env.config)) throw new ApiError(409,'RECEIVING_HOST_RESERVED',`${host} is one of ${productName}’s own hosts, so it can’t receive mail for ${row.name}.`,'host');
    // Once the domain receives somewhere (or the owner removed its own host), a chosen host goes beside the others.
    const established=establishedHost(row), own=row.hosts.find(h=>h.own);
    if (established || own?.status==='disabled' || (host!==null && row.hosts.some(h=>h.host===host && h.status!=='disabled'))) {
      if (host!==null && host!==established) await (await wrapModuleLoad(() => import('../receiving-hosts.js'))).addChosenHost(c,a.workspaceId,row,host,confirm).catch((e:unknown)=>{
        if (e instanceof ApiError && e.field==='name') throw new ApiError(e.status,e.code,e.message,'host',e.retryable);
        throw e;
      });
      return c.json(derivedReadiness(await hostedDomain(c.env.db,a.workspaceId,domainId) ?? notFound('Domain')),200);
    }
    let facts:Partial<IdentityFacts>={receivingChoice:null,issue:null};
    if (host!==null) {
      const {mx,issue}=await inspectReceivingHost(c.env.db,row,a.workspaceId,host,dnsUnavailable);
      if (issue?.code==='cname') throw new ApiError(409,'RECEIVING_HOST_CNAME',issue.message,'host');
      if (issue?.code==='bane_record') throw new ApiError(409,'RECEIVING_HOST_RESERVED',issue.message,'host');
      if (issue?.code==='host_taken') throw new ApiError(409,'RECEIVING_HOST_TAKEN',issue.message,'host');
      if (issue?.code==='claimed') throw new ApiError(409,'RECEIVING_HOST_CLAIMED',issue.message,'host');
      if (issue?.code==='delegated') throw new ApiError(409,'RECEIVING_HOST_DELEGATED',issue.message,'host');
      if (issue && ['foreign_mx','split','wrong_region','null_mx'].includes(issue.code) && !confirm)
        throw new ApiError(409,'RECEIVING_HOST_IN_USE',`Move mail for ${host}? ${issue.message} Send confirm: true to choose it anyway.`,'host');
      facts={receivingChoice:host,mx,issue};
    }
    const saved=await c.env.db.transaction(async db=>{
      const current=await hostedDomain(db,a.workspaceId,domainId,true);
      if (!current || current.token!==row.token || establishedHost(current)!==null) throw new ApiError(409,'DOMAIN_CHANGED','The domain changed while its DNS was checked. Try again.',undefined,true);
      const identity:IdentityFacts={...(current.identity ?? identityOnly({VerificationStatus:'PENDING'})),...facts,...(host===null ? {mx:null} : {})};
      await db.execute(sql`UPDATE domain_claims SET identity=${JSON.stringify(identity)}::jsonb WHERE workspace_id=${a.workspaceId} AND name=${current.name} AND token=${current.token}`);
      await recordAudit(db,c,{action:'domain.receiving_host',workspaceId:a.workspaceId,target:{type:'domain',id:domainId},before:{receivingChoice:current.identity?.receivingChoice ?? null},after:{name:current.name,receivingChoice:host}});
      return derivedReadiness({...current,identity});
    });
    return c.json(saved,200);
  });
  const dashboardSecurity=[{dashboardSession:[]},{secureDashboardSession:[]}] as Record<string,string[]>[];
  // The guarantee is the server's, not the dashboard's: no recipient is accepted, only the domain, and words of the
  // person's own are screened like any send (sending.ts platformTestVerdict).
  const setupLine=(max:number)=>z.string().trim().min(1).max(max);
  // Other fields are ignored, as they were before the route took any: no recipient is ever read from the body.
  const TestEmailContent=z.object({subject:setupLine(SETUP_LIMITS.subject).refine(v=>!/[\r\n]/.test(v),'Subject cannot contain line breaks.').optional(),text:setupLine(SETUP_LIMITS.text).optional()}).openapi('TestEmailContent');
  app.openapi(createRoute({method:'post',path:'/v1/domains/{id}/test-send',operationId:'sendDomainTestEmail',tags:['Domains'],security:dashboardSecurity,
    description:`Dashboard only. Sends a test email to the signed-in user’s own address; it takes no recipient. Without a body it is fixed content from hello@<domain>. With both subject and text (onboarding’s first email) it comes from "${SETUP_SENDER.name}" <${SETUP_SENDER.local}@<domain>> with those words, screened like any send unless they are onboarding’s own; a reply to it comes back into the workspace on a domain that receives. Other fields are ignored. Needs send permission and a verified domain, and counts like any other send. Use an Idempotency-Key to make a retry safe.`,
    request:{params:IdParams,body:{...json(TestEmailContent),required:false}},responses:{202:response(z.object({id:z.string(),status:z.literal('queued'),simulated:z.boolean()}).openapi('TestEmailQueued')),...errors}}),async c=>{
    const a=actor(c,'send'), content=c.req.valid('json') as z.infer<typeof TestEmailContent>|undefined;
    if (a.credential!=='dashboard' || !a.email) throw denied('DASHBOARD_SESSION_REQUIRED','Sign in to the dashboard to send a test email to yourself.',{ permission: 'sendEmail', level: 'on', credential: 'dashboard' });
    const [row]=await c.env.db.select({name:domains.name}).from(domains).where(and(scoped(domains,a),eq(domains.id,c.req.valid('param').id)));
    if (!row) return notFound('Domain');
    allowedDomain(a,row.name);
    const { admitTestEmail }=await wrapModuleLoad(() => import('../sending.js'));
    const custom=content?.subject && content.text ? { subject: content.subject, text: content.text } : undefined;
    return c.json(await admitTestEmail(c,a,row.name,a.email,custom),202);
  });
  const dnsSetup='/v1/domains/{id}/dns-setup';
  const dnsGroup=`(${groupIds.join('|')})`;
  app.openapi(createRoute({method:'get',path:dnsSetup,operationId:'getDomainDnsSetup',tags:['Domains'],security:dashboardSecurity,
    description:'MX owner/admin dashboard only. Returns a signed provider consent URL for eligible pending records, never changes DNS itself. API keys and agents should read the domain’s DNS records from GET /v1/domains/{id} (dns[]) instead. Inline discovery has a three-second budget; unsupported providers and discovery failures fall back to manual DNS. Receiving is offered only after DNS checks find the target empty.',
    request:{params:IdParams,query:z.object({groups:z.string().max(64).regex(new RegExp(`^${dnsGroup}(,${dnsGroup})*$`)).optional().describe('Optional comma-separated subset of pending groups. Only one receiving target is eligible: receiving (@) or receivingReply (reply). mailfrom is available only for email.<domain>; other MAIL FROM names use manual DNS.')})},
    responses:{200:response(z.object({provider:z.object({id:z.string(),name:z.string()}).nullable(),applyUrl:z.url().nullable(),groups:z.array(z.enum(groupIds))}).openapi('DomainDnsSetup')),...errors}}),async c=>{
    const a=dnsSetupActor(c), wid=a.workspaceId, id=c.req.valid('param').id;
    const row=await hostedDomain(c.env.db,wid,id) ?? notFound('Domain');
    if (row.identity?.builtin) throw builtinDomainFixed();
    const found=await discover(row.name);
    const [report]=await withLinkRecords(c.env,wid,[derivedReadiness(row)]);
    const selection=pendingGroups(report!,row.connection.kind==='shared',row.claim_scope!=='account' && (row.connection.kind==='byo' || row.pool_receiving) && row.identity?.mx?.state==='missing',row.sending_state==='failed' ? [] : c.req.valid('query').groups?.split(','));
    const provider=found && {id:found.id,name:found.name}, applyUrl=found && signedApply(c.env.config,found,row,selection,wid,a.keyId.slice(5));
    return c.json({provider,groups:selection.groups,applyUrl},200);
  });
  app.openapi(createRoute({method:'get',path:`${dnsSetup}/return/{token}`,operationId:'completeDomainDnsSetup',tags:['Domains'],security:dashboardSecurity,
    description:'Browser return from Domain Connect. Validates the ten-minute signed token and the initiating user’s current owner/admin membership in the workspace owning the domain, restores that workspace and returns to the domain page. An invalid or expired token returns to the domain page without changing anything. Success queues normal DNS/SES verification; a replay cannot create a second job. Provider approval is not proof.',
    request:{params:IdParams.extend({token:z.string().max(1600)}),query:z.object({state:z.string().max(1600).optional(),error:z.string().max(128).optional()})},
    responses:{303:{description:'Return to the domain in its original workspace.'},...errors}}),async c=>{
    if(!c.env.config.multiTenant) return notFound('Endpoint');
    const {id,token}=c.req.valid('param'), {state,error}=c.req.valid('query');
    // An expired or foreign token changes nothing but still lands on the domain page: the provider has
    // already applied the records by now, and the page's own polling picks up verification.
    const claim=verifyReturn(c.env.config.authSecret,token);
    // The page reopens in the workspace of the setup and, when this browser has a live session for the account that
    // started it (a browser can hold several), as that account. Nothing else names an account in the URL.
    const back=(account?:string)=>c.redirect(`${c.env.config.publicUrl}/domains/${encodeURIComponent(id)}${account?`?account=${encodeURIComponent(account)}`:''}`,303);
    if(!claim || claim.domainId!==id || (state!==undefined && state!==token)) return back();
    // A session that ended while the user was at the provider also goes back; the dashboard asks them to sign in.
    // The return is a navigation without the tab's X-Nightmail-Account: act as the initiating account's own session.
    const { verifiedDashboardUser } = await wrapModuleLoad(() => import('../dashboard-auth.js'));
    const headers=new Headers(c.req.raw.headers); headers.set(requestHeaderNames('account')[0]!,claim.userId);
    const user=await verifiedDashboardUser(c.env,headers).catch((e:unknown)=>{ if(e instanceof ApiError && (e.status===401 || e.status===403)) return null; throw e; });
    if(!user || claim.userId!==user.userId) return back();
    const {userId}=user;
    const wid=claim.workspaceId;
    const result=await c.env.db.execute(sql`WITH target AS (SELECT d.id,d.token FROM (${hostedDomainSelect(wid,id,sql`FOR SHARE OF dc`)}) d
      JOIN workspace_members m ON m.user_id=${userId} AND m.workspace_id=${wid} AND m.role IN ('owner','admin') FOR SHARE OF m),
      selected AS (UPDATE nightmail_users SET selected_workspace_id=${wid} WHERE id=${userId} AND selected_workspace_id IS DISTINCT FROM ${wid} AND EXISTS(SELECT 1 FROM target)),
      queued AS (${recheckJob(wid,sql`SELECT id,token FROM target WHERE ${error===undefined}`)}) SELECT 1 FROM target`);
    if(!result.rowCount) throw denied('PERMISSION_DENIED','Domain setup requires owner or admin access to the original workspace and domain.',{ permission: 'configuration', level: 'write', person: 'admin' });
    return back(userId);
  });
  for (const verifyRoute of [false, true]) app.openapi(createRoute({ method: verifyRoute ? 'post' : 'get', path: verifyRoute ? '/v1/domains/{id}/verify' : '/v1/domains/{id}', operationId: verifyRoute ? 'verifyDomain' : 'getDomain', description: verifyRoute ? 'On MX, request a background verification and return the current stored status, with what public DNS shows now for each pending sending and MAIL FROM record (dns[].publicDns), so a missing or mistyped record can be named, and where the domain\'s DNS is hosted (dnsHost). Read the domain again for updates.' : 'On MX, read the stored DNS records and verification status without an AWS call.', tags: ['Domains'], security, request: { params: IdParams }, responses: { 200: response(domainSchema), ...errors } }), async c => {
    const a = actor(c, verifyRoute ? 'manage' : 'read');
    // Check now: what public DNS shows now for each pending record, and where the zone is hosted. A Hosted domain the
    // background check already follows (a stored check, domain-setup.ts) keeps this answer, so its banner moves with it.
    const checked = async (report: Readiness) => {
      // The domain's link record is checked with it (src/link-domains.ts); domainLinkRecords adds it to the answer.
      await checkLinkHost(c.env, a.workspaceId, report.name);
      const stored = c.env.config.multiTenant && report.sending === 'pending' && report.dnsHost !== undefined;
      const check = await (await wrapModuleLoad(() => import('../record-check.js'))).checkSetup(report);
      if (check.records.length) { report.dnsHost = check.host; report.dnsIssue = check.noDns ? noDnsIssue(report.name) : null; }
      if (stored) await c.env.db.execute(sql`UPDATE domain_claims SET setup_check=${JSON.stringify(check)}::jsonb WHERE workspace_id=${a.workspaceId} AND name=${report.name} AND sending_state='pending' AND setup_check IS NOT NULL`);
      return report;
    };
    if (c.env.config.multiTenant) {
      if (verifyRoute) return c.json(await checked(await verifyHostedDomain(c.env,a,c.req.valid('param').id)),200);
      const mode=a.credential==='dashboard' && c.req.method==='GET' ? 'dashboard' : undefined;
      const row=await hostedDomain(c.env.db,a.workspaceId,c.req.valid('param').id,false,mode ? {domains:a.domains,mode,platformAccount:c.env.config.platformAccount} : undefined) ?? notFound('Domain'); allowedDomain(a,row.name);
      // A stale dashboard may read persisted facts; its opportunistic recheck was fenced in SQL.
      if (row.queued) a.wakeJobs=1;
      return c.json(derivedReadiness(row,c.env.config),200);
    }
    const [row] = await c.env.db.select().from(domains).where(and(scoped(domains, a), eq(domains.id, c.req.valid('param').id))); if (!row) return notFound('Domain'); allowedDomain(a, row.name);
    const report = await domainReadiness(c.env,row,undefined,verifyRoute?'verify':'read');
    return c.json(verifyRoute ? await checked(report) : report, 200);
  });
  app.openapi(createRoute({method:'delete',path:'/v1/domains/{id}',operationId:'deleteDomain',tags:['Domains'],security,description:'MX only. Delete this claim’s tagged SES identity and release the domain. Does not remove DNS records.',request:{params:IdParams},responses:{200:response(z.object({deleted:z.literal(true)})),...errors}}),async c=>{
    const a=actor(c,'manage'); if (!c.env.config.multiTenant) return notFound('Endpoint');
    const name=await c.env.db.transaction(async db=>{
      const row=await hostedDomain(db,a.workspaceId,c.req.valid('param').id,true);
      if (!row) {
        // A claim whose connection is gone has no SES identity to own; releasing it only frees the name.
        const detached=(await db.execute<{id:string;name:string;token:string}>(sql`SELECT d.id,d.name,dc.token FROM operation_domains d JOIN domain_claims dc ON dc.name=d.name AND dc.workspace_id=d.workspace_id
          WHERE d.workspace_id=${a.workspaceId} AND d.id=${c.req.valid('param').id} AND dc.connection_id IS NULL FOR UPDATE OF dc`)).rows[0] ?? notFound('Domain');
        allowedDomain(a,detached.name); await releaseClaim(db,a.workspaceId,detached);
        await recordAudit(db,c,{action:'domain.delete',workspaceId:a.workspaceId,target:{type:'domain',id:detached.id},before:{name:detached.name}});
        return detached.name;
      }
      allowedDomain(a,row.name);
      if (row.identity?.builtin) throw builtinDomainFixed();
      if (!row.identity?.imported) {
        await deleteClaimIdentity(c.env,a.workspaceId,row);
        if (row.connection.kind==='byo' && row.connection.legacy===false) await db.execute(sql`UPDATE provider_connection_regions SET ownership_journal=(
          SELECT coalesce(jsonb_agg(e ORDER BY n),'[]') FROM jsonb_array_elements(ownership_journal) WITH ORDINALITY entries(e,n) WHERE NOT e @> ${JSON.stringify(identityJournalEntry(row))}::jsonb)
          WHERE connection_id=${row.connection.id} AND region=${row.region} AND NOT legacy`);
      }
      await releaseClaim(db,a.workspaceId,row);
      if (row.connection.kind==='byo' && row.receiving_host) await (await wrapModuleLoad(() => import('../mailbox-setup.js'))).queueReconcile(db,a.workspaceId,row.region);
      await recordAudit(db,c,{action:'domain.delete',workspaceId:a.workspaceId,target:{type:'domain',id:row.id},before:{name:row.name,region:row.region,receivingHost:row.receiving_host}});
      return row.name;
    });
    await forgetLinkHost(c.env,a.workspaceId,name);
    return c.json({deleted:true as const},200);
  });
}
export function registerMetrics(app: App) {
  // The window's aggregate is one statement that reads every email in it (a 30-day Overview reads all retained mail):
  // it stops after 5 seconds with READ_TOO_LARGE rather than hold a connection.
  const METRICS_READ = 5;
  const query = z.object({ region: z.string().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), stream: z.enum(['transactional', 'marketing']).optional(), granularity: z.enum(['day', 'hour', '10m']).default('day'), include: z.string().regex(/^(?:previous|streams)(?:,(?:previous|streams))*$/).optional().describe('Comma-separated extras computed in the same statement: previous (totals for the window of equal length ending at from) and streams (totals per stream for the window, ignoring the stream filter).') }).openapi('MetricsQuery');
  const bucket = z.object({ date: z.string(), count: z.number(), sent: z.number(), delivered: z.number(), bounced: z.number(), complained: z.number() });
  const totalsSchema = z.object({ emails: z.number(), accepted: z.number(), delivered: z.number(), bounced: z.number(), complained: z.number(), opened: z.number(), clicked: z.number(), failed: z.number(), deliveryDelayed: z.number(), simulated: z.number() });
  const schema = z.object({ basis: z.literal('created-cohort'), from: z.string(), to: z.string(), region: z.string().nullable(), stream: z.string().nullable(), totals: totalsSchema, daily: z.array(bucket), hourly: z.array(bucket).optional(), tenMinute: z.array(bucket).optional(), previous: z.object({ from: z.string(), to: z.string(), totals: totalsSchema }).optional().describe('Present with include=previous.'), streams: z.object({ transactional: totalsSchema, marketing: totalsSchema }).optional().describe('Present with include=streams.') }).openapi('Metrics');
  app.openapi(createRoute({ method: 'get', path: '/v1/metrics', operationId: 'getMetrics', description: 'Operational created-cohort metrics, not invoicing or provider reputation. ' + DASHBOARD_CACHE_NOTE + ' Selects emails created in [from,to), scoped by email region and stream. to defaults to now and from to 24 hours (granularity=10m) or 30 days before to; from equal to to is an empty window. Outcomes use current email state and all recorded events, including events after to; this is not a historical state snapshot. Each outcome counts distinct emails, so replays do not inflate counts and outcomes may overlap. Accepted (bucket sent) means evidence of provider acceptance, not merely queued/created. Daily UTC creation buckets contain count=created emails. Granularity defaults to day; granularity=hour returns hourly UTC creation buckets and granularity=10m returns 10-minute UTC creation buckets (within the last 6 days) with canonical ISO dates, while preserving daily buckets and totals. Absent buckets mean zero created emails and zero outcomes; no moving averages are applied. Engagement is observed, not verified human activity. ' + readLimitNote(METRICS_READ), tags: ['Metrics'], security, request: { query }, responses: { 200: response(schema), ...errors } }), async c => {
    // Only a range the caller wrote can be refused: an omitted end is now (or the given start, if that is later, which
    // reads as an empty window), and an omitted start is a window that fits the granularity (24 hours for 10m, else 30 days).
    // A zero-length window is empty, not inverted.
    const a = workspaceActor(c), q = c.req.valid('query'), nowMs = Date.now();
    const end = q.to ?? (q.from && Date.parse(q.from) > nowMs ? q.from : new Date(nowMs).toISOString());
    const start = q.from ?? new Date(Date.parse(end) - (q.granularity === '10m' ? 1 : 30) * 86400000).toISOString();
    const qStartMs = Date.parse(start), qEndMs = Date.parse(end);
    if (qStartMs > qEndMs || qEndMs - qStartMs > (q.granularity === '10m' ? 6 : 366) * 86400000 || (q.granularity === '10m' && qStartMs < nowMs - 6 * 86400000)) {
      throw new ApiError(422, 'INVALID_DATE_RANGE', q.granularity === '10m' ? '10-minute metrics require a range within the last 6 days with from no later than to.' : 'Metrics require a range of at most 366 days with from no later than to.');
    }
    const compute = async () => {
    if (q.region) region(await withRegionSettings(c.env,a.workspaceId),q.region);
    const extras = new Set((q.include ?? '').split(',').filter(Boolean));
    const date = q.granularity === '10m'
      ? sql<string | null>`to_char(date_bin('10 minutes', ${emails.createdAt}, timestamptz '2000-01-01 00:00:00+00') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI":00.000Z"')`
      : q.granularity === 'hour' ? sql<string | null>`to_char(${emails.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24":00:00.000Z"')`
      : sql<string | null>`to_char(${emails.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
    // Outcomes come from the per-email flags kept by the operation_events trigger (migration 031): the same
    // union of public events the old per-query event aggregation produced, without re-reading the events.
    type Row = { date: string; emails: number; accepted: number; delivered: number; bounced: number; complained: number; opened: number; clicked: number; failed: number; deliveryDelayed: number; simulated: number };
    const e = 'sending_emails', counts = sql`count(*)::int AS "emails",
      count(*) FILTER (WHERE NOT ${emails.simulated} AND ${emailAccepted(e)})::int AS "accepted",
      count(*) FILTER (WHERE ${emailDelivered(e)})::int AS "delivered",
      count(*) FILTER (WHERE ${emailBounced(e)})::int AS "bounced",
      count(*) FILTER (WHERE ${emailComplained(e)})::int AS "complained",
      count(*) FILTER (WHERE ${emailHas(e, 'opened')})::int AS "opened", count(*) FILTER (WHERE ${emailHas(e, 'clicked')})::int AS "clicked",
      count(*) FILTER (WHERE ${emails.status} IN ('rejected', 'rendering_failed') OR ${emailHas(e, 'failed')})::int AS "failed",
      count(*) FILTER (WHERE ${emails.status} = 'delayed' OR ${emailHas(e, 'delayed')})::int AS "deliveryDelayed",
      count(*) FILTER (WHERE ${emails.simulated})::int AS "simulated"`;
    const total = (row?: Partial<Row>) => ({ emails: row?.emails ?? 0, accepted: row?.accepted ?? 0, delivered: row?.delivered ?? 0, bounced: row?.bounced ?? 0, complained: row?.complained ?? 0, opened: row?.opened ?? 0, clicked: row?.clicked ?? 0, failed: row?.failed ?? 0, deliveryDelayed: row?.deliveryDelayed ?? 0, simulated: row?.simulated ?? 0 });
    type Totals = ReturnType<typeof total>;
    type KindHourRow = Totals & { hour: string; kind: string };
    const addTotals = (acc: Totals, item: Partial<Totals>) => {
      for (const key of Object.keys(acc) as Array<keyof Totals>) acc[key] += Number(item[key] ?? 0);
      return acc;
    };
    let rows: Row[], previous: { from: string; to: string; totals: Totals } | undefined, streams: { transactional: Totals; marketing: Totals } | undefined;
    const HOUR_MS = 3_600_000, TEN_MIN_MS = 600_000;
    const floorStep = (ms: number, step: number) => Math.floor(ms / step) * step;
    const ceilStep = (ms: number, step: number) => (ms % step === 0 ? ms : floorStep(ms, step) + step);
    const startMs = Date.parse(start), endMs = Date.parse(end);
    const previousFromMs = startMs - (endMs - startMs), previousFrom = new Date(previousFromMs).toISOString();
    const scanFromMs = extras.has('previous') ? previousFromMs : startMs;
    const useTenMinuteRollup = q.granularity === '10m';

    if (await talliesEnabled(c.env.db)) {
      // Exact at read time: reads sending_metrics_ten_minute (for 10m within the 6-day rolling window) or
      // sending_metrics_hourly (for hour/day and previous-period totals), touching raw sending_emails only for
      // non-empty partial edge buckets (zero raw rows for Overview's right edge to=now()).
      const result = await budgetedRead(c.env.db, async db => {
        const readRollup = async (table: 'sending_metrics_hourly' | 'sending_metrics_ten_minute', col: 'hour' | 'bucket', fmt: string, fromMs: number, toMs: number, step: number) => {
          const minAt = new Date(floorStep(fromMs, step)).toISOString();
          const maxAt = new Date(floorStep(toMs - 1, step) + step).toISOString();
          const tbl = sql.raw(table), cCol = sql.raw(col), cFmt = sql.raw(fmt);
          const rollupRows = (await db.execute<KindHourRow>(sql`SELECT
            to_char(${cCol} AT TIME ZONE 'UTC', '${cFmt}') AS hour, kind,
            sum(emails)::int AS emails, sum(accepted)::int AS accepted, sum(delivered)::int AS delivered,
            sum(bounced)::int AS bounced, sum(complained)::int AS complained, sum(opened)::int AS opened,
            sum(clicked)::int AS clicked, sum(failed)::int AS failed,
            sum(delivery_delayed)::int AS "deliveryDelayed", sum(simulated)::int AS simulated
            FROM ${tbl}
            WHERE workspace_id = ${a.workspaceId} AND ${cCol} >= ${minAt}::timestamptz AND ${cCol} < ${maxAt}::timestamptz
              ${q.region ? sql`AND region = ${q.region}` : sql``}
              ${q.stream && !extras.has('streams') ? sql`AND kind = ${q.stream}` : sql``}
            GROUP BY 1, 2 HAVING sum(emails) <> 0`)).rows;
          const bySlot = new Map<number, KindHourRow[]>();
          for (const r of rollupRows) {
            const ms = Date.parse(r.hour);
            const list = bySlot.get(ms);
            if (list) list.push(r); else bySlot.set(ms, [r]);
          }
          return bySlot;
        };
        const collectFrom = async (bySlot: Map<number, KindHourRow[]>, fromMs: number, toMs: number, step: number): Promise<KindHourRow[]> => {
          const scanEdge = async (eFrom: number, eTo: number): Promise<KindHourRow[]> => {
            const sMs = floorStep(eFrom, step);
            if (!bySlot.has(sMs)) return [];
            const slotIso = new Date(sMs).toISOString();
            const filter = and(scoped(emails, a), gte(emails.createdAt, new Date(eFrom).toISOString()), lt(emails.createdAt, new Date(eTo).toISOString()),
              q.region ? eq(emails.region, q.region) : undefined, q.stream && !extras.has('streams') ? sql`${emails.snapshot}->>'kind' = ${q.stream}` : undefined);
            const { rows: edgeRows } = await db.execute<Totals & { kind: string }>(sql`SELECT
              coalesce(${emails.snapshot}->>'kind', '') AS kind,
              ${counts}
              FROM ${emails} WHERE ${filter} GROUP BY 1`);
            return edgeRows.map(r => ({ ...r, hour: slotIso }));
          };
          const out: KindHourRow[] = [];
          const wStart = ceilStep(fromMs, step);
          let wEnd = floorStep(toMs, step);
          if (toMs > wEnd && fromMs <= wEnd) {
            if (!bySlot.has(wEnd)) {
              wEnd += step;
            } else {
              const nextSlot = new Date(wEnd + step).toISOString();
              const { rows: [after] } = await db.execute<{ any: boolean }>(sql`SELECT EXISTS (
                SELECT 1 FROM sending_emails WHERE workspace_id = ${a.workspaceId}
                  AND created_at >= ${new Date(toMs).toISOString()}::timestamptz AND created_at < ${nextSlot}::timestamptz
              ) AS any`);
              if (!after?.any) wEnd += step;
            }
          }
          if (wStart > wEnd) {
            out.push(...await scanEdge(fromMs, toMs));
            return out;
          }
          for (const [sMs, list] of bySlot) if (sMs >= wStart && sMs < wEnd) out.push(...list);
          if (fromMs < wStart) out.push(...await scanEdge(fromMs, wStart));
          if (wEnd < toMs) out.push(...await scanEdge(wEnd, toMs));
          return out;
        };
        if (useTenMinuteRollup) {
          const byTen = await readRollup('sending_metrics_ten_minute', 'bucket', 'YYYY-MM-DD"T"HH24:MI":00.000Z"', startMs, endMs, TEN_MIN_MS);
          const currentItems = await collectFrom(byTen, startMs, endMs, TEN_MIN_MS);
          const previousItems = extras.has('previous')
            ? await collectFrom(await readRollup('sending_metrics_hourly', 'hour', 'YYYY-MM-DD"T"HH24":00:00.000Z"', previousFromMs, startMs, HOUR_MS), previousFromMs, startMs, HOUR_MS)
            : [];
          return { currentItems, previousItems };
        }
        const byHour = await readRollup('sending_metrics_hourly', 'hour', 'YYYY-MM-DD"T"HH24":00:00.000Z"', scanFromMs, endMs, HOUR_MS);
        const currentItems = await collectFrom(byHour, startMs, endMs, HOUR_MS);
        const previousItems = extras.has('previous') ? await collectFrom(byHour, previousFromMs, startMs, HOUR_MS) : [];
        return { currentItems, previousItems };
      }, readLimit(METRICS_READ));

      const matchShown = (item: KindHourRow) => !q.stream || item.kind === q.stream;
      const byBucket = new Map<string, Totals>();
      for (const item of result.currentItems) {
        if (!matchShown(item)) continue;
        const key = q.granularity === 'day' ? item.hour.slice(0, 10) : item.hour;
        const acc = byBucket.get(key) ?? total();
        addTotals(acc, item);
        byBucket.set(key, acc);
      }
      rows = [...byBucket].map(([dateKey, acc]) => ({ ...acc, date: dateKey })).sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
      if (extras.has('previous')) {
        const prevTotals = total();
        for (const item of result.previousItems) if (matchShown(item)) addTotals(prevTotals, item);
        previous = { from: previousFrom, to: start, totals: prevTotals };
      }
      if (extras.has('streams')) {
        const ownKind: 'transactional' | 'marketing' = q.stream ?? 'marketing';
        const all = total(), own = total();
        for (const item of result.currentItems) {
          addTotals(all, item);
          if (item.kind === ownKind) addTotals(own, item);
        }
        const rest = Object.fromEntries(Object.keys(all).map(key => [key, all[key as keyof Totals] - own[key as keyof Totals]])) as Totals;
        streams = ownKind === 'marketing' ? { transactional: rest, marketing: own } : { transactional: own, marketing: rest };
      }
    } else if (!extras.size) {
      const filter = and(scoped(emails, a), gte(emails.createdAt, start), lt(emails.createdAt, end), q.region ? eq(emails.region, q.region) : undefined, q.stream ? sql`${emails.snapshot}->>'kind' = ${q.stream}` : undefined);
      rows = (await budgetedRead(c.env.db, db => db.execute<Row>(sql`
      SELECT ${date} AS "date", ${counts}
      FROM ${emails}
      WHERE ${filter}
      GROUP BY 1 ORDER BY 1`), readLimit(METRICS_READ))).rows;
    } else {
      // One statement that never reads snapshot except through sending_emails_kind_created (workspace, snapshot->>'kind',
      // created_at); snapshot is TOASTed and detoasting it per row costs seconds. Every email is created as exactly one of
      // the two kinds, so counts are additive across kinds and the second stream is the total minus the first:
      //  - an "all" arm groups the window (and the previous window when asked) directly, with no kind predicate;
      //  - one "kind" arm (the stream filter, or marketing when only the per-stream totals are asked for) uses the index.
      // Each arm groups by (in the window, creation bucket); rows before the window have no bucket (previous period).
      const previousFrom = new Date(Date.parse(start) - (Date.parse(end) - Date.parse(start))).toISOString();
      const scanFrom = extras.has('previous') ? previousFrom : start;
      const kind: 'transactional' | 'marketing' = q.stream ?? 'marketing';
      const needAll = !q.stream || extras.has('streams'), needKind = !!q.stream || extras.has('streams');
      const inWindow = sql`${emails.createdAt} >= ${start}::timestamptz`;
      const bucketOf = sql`CASE WHEN ${inWindow} THEN ${date} END`;
      const within = (from: string) => and(scoped(emails, a), gte(emails.createdAt, from), lt(emails.createdAt, end), q.region ? eq(emails.region, q.region) : undefined);
      const arm = (part: 'all' | 'kind', from: string) => sql`SELECT ${part}::text AS part, ${inWindow} AS cur, ${bucketOf} AS "date", ${counts}
        FROM ${emails} WHERE ${and(within(from), part === 'kind' ? sql`(${emails.snapshot}->>'kind') = ${kind === 'marketing' ? sql`'marketing'::text` : sql`'transactional'::text`}` : undefined)} GROUP BY 2, 3`;
      const arms = [...(needAll ? [arm('all', q.stream ? start : scanFrom)] : []), ...(needKind ? [arm('kind', q.stream ? scanFrom : start)] : [])];
      const parts = (await budgetedRead(c.env.db, db => db.execute<Row & { part: 'all' | 'kind'; cur: boolean }>(arms.length > 1 ? sql`${arms[0]} UNION ALL ${arms[1]}` : arms[0]!), readLimit(METRICS_READ))).rows;
      const sum = (list: Row[]) => list.reduce((acc, row) => { for (const key of Object.keys(acc) as Array<keyof typeof acc>) acc[key] += row[key]; return acc; }, total());
      const shown = parts.filter(row => row.part === (q.stream ? 'kind' : 'all'));
      const byDate = new Map<string, Row[]>();
      for (const row of shown) if (row.cur) byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
      rows = [...byDate].map(([day, list]) => ({ ...sum(list), date: day })).sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
      if (extras.has('previous')) previous = { from: previousFrom, to: start, totals: sum(shown.filter(row => !row.cur)) };
      if (extras.has('streams')) {
        const all = sum(parts.filter(row => row.part === 'all' && row.cur)), own = sum(parts.filter(row => row.part === 'kind' && row.cur));
        const rest = Object.fromEntries(Object.keys(all).map(key => [key, all[key as keyof typeof all] - own[key as keyof typeof own]])) as typeof all;
        streams = kind === 'marketing' ? { transactional: rest, marketing: own } : { transactional: own, marketing: rest };
      }
    }
    // Every email belongs to exactly one creation bucket, so totals are the sum of the buckets (no ROLLUP sort).
    const totals = { emails: 0, accepted: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, failed: 0, deliveryDelayed: 0, simulated: 0 };
    for (const row of rows) for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += row[key];
    const buckets = rows.map(row => ({ date: row.date!, count: row.emails, sent: row.accepted, delivered: row.delivered, bounced: row.bounced, complained: row.complained }));
    let daily = buckets;
    if (q.granularity !== 'day') {
      const days = new Map<string, z.infer<typeof bucket>>();
      // Every email belongs to one creation bucket, so its outcome counts remain additive by day.
      for (const row of buckets) {
        const date = row.date.slice(0, 10), day = days.get(date);
        if (day) for (const key of ['count', 'sent', 'delivered', 'bounced', 'complained'] as const) day[key] += row[key];
        else days.set(date, { ...row, date });
      }
      daily = [...days.values()];
    }
    return { basis: 'created-cohort' as const, from: start, to: end, region: q.region ?? null, stream: q.stream ?? null, totals, daily, ...(q.granularity === 'hour' ? { hourly: buckets } : {}), ...(q.granularity === '10m' ? { tenMinute: buckets } : {}), ...(previous ? { previous } : {}), ...(streams ? { streams } : {}) };
    };
    // Dashboards poll this aggregate (older builds every 3 s, in every open tab). Dashboard sessions share a
    // 60-second cache per workspace/filters/window; API keys, MCP and agent tokens stay exact.
    if (a.credential !== 'dashboard') return c.json(await compute(), 200);
    const startMs = Date.parse(start), endMs = Date.parse(end);
    // "Last N days/hours as of now" windows move every request; bucket them by minute and window length.
    // The Overview's "previous period" ends one window-length ago, so it is relative too: key it by how far back it
    // ends as well, or it never hits the cache.
    const length = endMs - startMs, back = nowMs - endMs;
    const window = Math.abs(back) <= 120_000 || Math.abs(back - length) <= 120_000 ? `rel:${Math.floor(nowMs / 60_000)}:${Math.round(back / 60_000)}:${Math.round(length / 60_000)}` : `abs:${start}:${end}`;
    // Cached until the workspace's next email or email event, so a send or delivery shows on the next read, the same
    // moment Logs lists it, instead of up to a minute later.
    const body = await dashboardRead(c, ['metrics', a.workspaceId, q.region ?? '', q.stream ?? '', q.granularity, [...new Set((q.include ?? '').split(',').filter(Boolean))].sort().join(','), window].join('|'), compute);
    c.header('x-nightmail-metrics-cache', body.cache);
    return c.json(body.value, 200);
  });
}
