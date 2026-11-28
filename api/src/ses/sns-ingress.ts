import { z, createRoute } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { X509Certificate, verify } from 'node:crypto';
import { ApiError, logError, errors, wrapModuleLoad, ModuleLoadError } from '../core/errors.js';
import { response } from '../core/http.js';
import { log } from '../log.js';
import type { Runtime, App } from '../core/types.js';
import { poolSends, poolReceives, connectionReady } from '../states.js';
import { resolveRegionRuntime } from '../ses-region-state.js';
import { feedbackUrl, byoFeedbackUrl, awsError } from '../ses-setup.js';
import { clientIpHeader, productName } from '../brand.js';
import { TAG_PREFIX } from '../resource-tags.js';
import { verifySesAccount, sesFeedbackIdentity, loadSendingOps, routineInput } from './feedback.js';

const snsSchema = z.object({ Type: z.enum(['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation']), MessageId: z.string().min(1).max(200), TopicArn: z.string().min(1).max(300), Message: z.string().max(262144), Timestamp: z.string().datetime(), SignatureVersion: z.enum(['1', '2']), Signature: z.string().min(1).max(4096), SigningCertURL: z.string().url().max(2048), Subject: z.string().max(1000).optional(), SubscribeURL: z.string().url().max(4096).optional(), Token: z.string().max(4096).optional() }).openapi('SnsSignedEnvelope');
type SnsEnvelope = z.infer<typeof snsSchema>;
const SnsAccepted = z.object({ accepted: z.boolean() }).openapi('SnsAccepted');
function snsHost(envelope: SnsEnvelope) {
  const match = /^arn:aws:sns:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:[A-Za-z0-9_-]+$/.exec(envelope.TopicArn);
  if (!match) throw new ApiError(403, 'SNS_TOPIC_NOT_ALLOWED', 'Only registered standard AWS regional SNS topics are supported.');
  return { host: `sns.${match[1]}.amazonaws.com`, region: match[1]! };
}
function trustedSnsUrl(value: string, host: string, certificate: boolean) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password || url.hash || (certificate ? !/^\/SimpleNotificationService-[0-9a-fA-F]{32}\.pem$/.test(url.pathname) || value !== `https://${host}${url.pathname}` : url.pathname !== '/')) throw new ApiError(403, 'SNS_UNTRUSTED_URL', 'SNS certificate or subscription URL is not trusted.');
  return url;
}
// Node has no edge rate-limit binding. Reserve a miss synchronously, before I/O;
// at capacity refuse new miss buckets rather than evicting a live peer's budget.
function allowLocalCertMiss(certMissPeers: SnsCertificateState['peers'], peer: string) {
  const now = Date.now();
  for (const [key, bucket] of certMissPeers) {
    if (bucket.until > now) break;
    certMissPeers.delete(key);
  }
  const bucket = certMissPeers.get(peer);
  if (bucket) {
    if (bucket.count >= 60) return false;
    bucket.count++;
    return true;
  }
  if (certMissPeers.size >= 4096) return false;
  certMissPeers.set(peer, { count: 1, until: now + 60_000 });
  return true;
}
// Public certificates rotate infrequently. Reserve synchronously after the
// prefix check and before fetch; never queue waiters or share request I/O.
const certMissLimited = () => new ApiError(429, 'SNS_CERTIFICATE_RATE_LIMITED', 'Too many SNS certificate lookups. Retry after one minute.', undefined, true);
export class SnsCertMissBudget {
  private starts: number[] = [];
  private active = 0;
  constructor(private readonly clock = () => performance.now()) {}
  async run<T>(lookup: () => Promise<T>) {
    const now=this.clock();
    while (this.starts.length && this.starts[0]! <= now - 60_000) this.starts.shift();
    if (this.active >= 4 || this.starts.length >= 96) throw certMissLimited();
    this.active++; this.starts.push(now);
    try { return await lookup(); } finally { this.active--; }
  }
}
export class SnsCertificateState {
  // Share completed, public certificates, never an in-flight fetch. Only a
  // verified signature pins its signer independently of candidates and 404s.
  readonly candidates = new Map<string, { cert: X509Certificate; expiresAt: number }>();
  readonly verifiedSigners = new Map<string, X509Certificate>();
  readonly missingCertificates = new Map<string, number>();
  readonly peers = new Map<string, { count: number; until: number }>();
  readonly budget = new SnsCertMissBudget();
}
const isolateCertState = new SnsCertificateState();
async function fetchSnsCert(url: URL, certificateTimeout: number, missingCertificates: Map<string,number>) {
    // Certificate bytes come only from the allowlisted AWS HTTPS origin, protected by TLS PKI.
    // Workers require manual redirects; every non-2xx response below fails closed.
    let res: Response;
    try { res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(certificateTimeout) }); } catch (error) { logError(error, { code: 'SNS_CERTIFICATE_FETCH_FAILED' }, 'warn'); throw new ApiError(503, 'SNS_CERTIFICATE_UNAVAILABLE', 'The SNS signing certificate could not be retrieved.', undefined, true); }
    if (!res.ok) {
      await res.body?.cancel();
      if(res.status===404 || res.status===410){
        if(missingCertificates.size>=256)missingCertificates.delete(missingCertificates.keys().next().value!);
        missingCertificates.set(url.href,Date.now()+60000);throw new ApiError(403,'SNS_INVALID_CERTIFICATE','The SNS signing certificate does not exist.');
      }
      log('warn', { code: 'SNS_CERTIFICATE_FETCH_FAILED', status: res.status }); throw new ApiError(503, 'SNS_CERTIFICATE_UNAVAILABLE', 'The SNS signing certificate could not be retrieved.', undefined, true);
    }
    const pem = await res.text(); if (pem.length > 16384) throw new ApiError(403, 'SNS_INVALID_CERTIFICATE', 'The SNS signing certificate is invalid.');
    try { return new X509Certificate(pem); } catch { throw new ApiError(403, 'SNS_INVALID_CERTIFICATE', 'The SNS signing certificate is invalid.'); }
}
/**
 * A budget of failed SNS signatures, checked before any verification work. SNS itself never fails verification, so its
 * traffic never spends it. A peer gets SNS_PEER_FAILURES failures a minute in each isolate (and its share of the edge
 * limiter across isolates); past SNS_ISOLATE_FAILURES in an isolate, a peer that has failed this minute gets no more tries
 * unless it verified in the last 15 minutes. A peer with no failure is always verified: SNS delivers from addresses this
 * isolate may not have seen yet, and its feedback must keep flowing.
 */
const SNS_PEER_FAILURES = 20, SNS_ISOLATE_FAILURES = 1200, SNS_PEERS = 4096;
export class SnsFailureBudget {
  private minute = 0; private total = 0;
  private readonly failures = new Map<string, number>(); private readonly verified = new Map<string, number>();
  constructor(private readonly clock = () => Date.now()) {}
  private tick() { const minute = Math.floor(this.clock() / 60_000); if (minute !== this.minute) { this.minute = minute; this.total = 0; this.failures.clear(); } }
  /** Whether this peer may be verified now: a check of counts, before any cryptography. */
  admits(peer: string) {
    this.tick();
    if ((this.failures.get(peer) ?? 0) >= SNS_PEER_FAILURES) return false;
    return this.total < SNS_ISOLATE_FAILURES || !this.failures.has(peer) || (this.verified.get(peer) ?? 0) > this.clock();
  }
  failed(peer: string, edgeExhausted = false) {
    this.tick(); this.total++;
    if (!this.failures.has(peer) && this.failures.size >= SNS_PEERS) return;
    this.failures.set(peer, edgeExhausted ? SNS_PEER_FAILURES : (this.failures.get(peer) ?? 0) + 1);
  }
  succeeded(peer: string) {
    this.verified.delete(peer);
    if (this.verified.size >= SNS_PEERS) this.verified.delete(this.verified.keys().next().value!);
    this.verified.set(peer, this.clock() + 15 * 60_000);
  }
}
const isolateSnsFailures = new SnsFailureBudget();
const snsFailuresLimited = () => new ApiError(429, 'SNS_RATE_LIMITED', 'Too many SNS envelopes failed verification from this address. Retry after one minute.', undefined, true);
async function verifySns(envelope: SnsEnvelope, runtime: Runtime, peer: string) {
  const failures = runtime.snsFailureBudget ?? isolateSnsFailures;
  if (!failures.admits(peer)) throw snsFailuresLimited();
  try {
    const trusted = await verifySnsSignature(envelope, runtime, peer);
    failures.succeeded(peer);
    return trusted;
  } catch (error) {
    // A signature that fails spends the peer's budget (certificate misses have their own budget); the edge limiter's
    // refusal spends the rest of it here.
    if (error instanceof ApiError && error.code === 'SNS_INVALID_SIGNATURE') failures.failed(peer, runtime.allowSnsFailure ? !await runtime.allowSnsFailure(peer).catch(() => true) : false);
    throw error;
  }
}
async function verifySnsSignature(envelope: SnsEnvelope, runtime: Runtime, peer: string) {
  const certificateTimeout = envelope.Type === 'SubscriptionConfirmation' ? 3000 : 10000;
  const trusted = snsHost(envelope);
  const url = trustedSnsUrl(envelope.SigningCertURL, trusted.host, true);
  const signature = Buffer.from(envelope.Signature, 'base64');
  if (signature.length < 256 || signature.length > 1024 || signature.toString('base64') !== envelope.Signature) throw new ApiError(403, 'SNS_INVALID_SIGNATURE', 'SNS signature encoding or length is invalid.');
  const fields = envelope.Type === 'Notification' ? ['Message', 'MessageId', ...(envelope.Subject !== undefined ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type'] : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const values = envelope as Record<string, unknown>;
  if (fields.some(field => typeof values[field] !== 'string')) throw new ApiError(400, 'SNS_INVALID_ENVELOPE', 'Required signed SNS fields are missing.');
  const {candidates:snsCertificates, verifiedSigners, missingCertificates, peers, budget} = runtime.snsCertificateState ?? isolateCertState;
  const cached = snsCertificates.get(url.href);
  const pinned = verifiedSigners.get(url.href);
  let cert = pinned && Date.parse(pinned.validTo)>Date.now() ? pinned : cached && cached.expiresAt > Date.now() ? cached.cert : undefined;
  if (!cert) {
    if((missingCertificates.get(url.href)??0)>Date.now()) throw new ApiError(403,'SNS_INVALID_CERTIFICATE','The SNS signing certificate does not exist.');
    if (!(runtime.allowSnsCertMiss ? await runtime.allowSnsCertMiss(peer) : allowLocalCertMiss(peers,peer))) throw certMissLimited();
    cert=await budget.run(() => fetchSnsCert(url,certificateTimeout,missingCertificates));
  }
  if (Date.now() < Date.parse(cert.validFrom) || Date.now() > Date.parse(cert.validTo) || cert.publicKey.asymmetricKeyType !== 'rsa') throw new ApiError(403, 'SNS_INVALID_CERTIFICATE', 'The SNS signing certificate is expired or invalid.');
  if (cert !== pinned && (!cached || cached.expiresAt <= Date.now())) {
    if (snsCertificates.size >= 8) snsCertificates.delete(snsCertificates.keys().next().value!);
    snsCertificates.set(url.href, { cert, expiresAt: Math.min(Date.now() + 300000, Date.parse(cert.validTo)) });
  }
  const canonical = fields.map(field => `${field}\n${values[field]}\n`).join('');
  if (!verify(envelope.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1', Buffer.from(canonical), cert.publicKey, signature)) throw new ApiError(403, 'SNS_INVALID_SIGNATURE', 'SNS signature verification failed.');
  if (cert !== pinned) {
    for(const [key,value] of verifiedSigners) if(Date.parse(value.validTo)<=Date.now()) verifiedSigners.delete(key);
    verifiedSigners.set(url.href,cert);
  }
  return trusted;
}
export function registerPublicEvents(app: App) {
  type TopicBinding = { region: string; aws_account_id: string; kind: 'byo' | 'shared'; ready: boolean; inbound:boolean; managed_id:string|null;generation:number|null };
  const sendingTopics = new Map<string, { binding: TopicBinding; expires: number }>();
  async function sendingTopic(runtime: Runtime, arn: string, confirming: boolean) {
    const cached = sendingTopics.get(arn);
    if (!confirming && cached && cached.expires > Date.now()) return cached.binding;
    // Only a confirmation matches a journaled, not-yet-ready subscription. Without a public endpoint there is none to match.
    let subscription:string|null=null,byoSubscription:string|null=null;
    if (confirming) try { subscription=JSON.stringify([{kind:'subscription',resource:arn,target:feedbackUrl(runtime.config)}]); } catch {}
    // A connected account's topics subscribe to BYO_EVENTS_ORIGIN when it's set (byoFeedbackUrl).
    if (confirming) try { byoSubscription=JSON.stringify([{kind:'subscription',resource:arn,target:byoFeedbackUrl(runtime.config)}]); } catch {}
    const binding = (await runtime.db.execute<TopicBinding>(sql`
      SELECT r.region,c.aws_account_id,c.kind,r.sending_state='ready' AS ready,false AS inbound,CASE WHEN NOT r.legacy THEN c.id END AS managed_id,r.generation
        FROM provider_connection_regions r JOIN provider_connections c ON c.id=r.connection_id WHERE c.kind='byo' AND r.feedback_topic_arn=${arn} AND (r.legacy OR r.sending_state='ready' OR
          (r.sending_state='provisioning' AND r.ownership_journal @> ${byoSubscription}::jsonb))
      UNION ALL SELECT region, aws_account_id, 'shared', ${poolSends()},false,CASE WHEN NOT legacy_names THEN 'pool' END,generation FROM provider_pool_regions p WHERE feedback_topic_arn=${arn} AND (legacy_names OR ${poolSends()} OR
        (${!!runtime.config.trustedPool} AND p.region='us-east-1' AND pool_tier='trusted' AND ownership_journal @> ${subscription}::jsonb))
      UNION ALL SELECT region,aws_account_id,'shared',${poolReceives()},true,NULL,NULL FROM provider_pool_regions p WHERE inbound_topic_arn=${arn}
      ${!confirming && TAG_PREFIX==='nightmail' ? sql`UNION ALL SELECT region,aws_account_id,'shared',true,true,NULL,NULL FROM provider_pool_regions p
        WHERE region='us-east-2' AND aws_account_id=${runtime.config.platformAccount??''} AND ${poolReceives()} AND inbound_topic_arn='arn:aws:sns:us-east-2:'||aws_account_id||':nightmail-inbound'
        AND ${arn}='arn:aws:sns:us-east-2:'||aws_account_id||':bane-inbound'` : sql``}
      UNION ALL SELECT r.region,r.account_id,'byo',${connectionReady(sql`c`)},true,NULL,NULL FROM mailbox_regions r JOIN provider_connections c ON c.workspace_id=r.workspace_id AND c.aws_account_id=r.account_id AND c.region=r.region AND c.kind='byo' AND c.template_version<>'v5' WHERE r.topic_arn=${arn}
      ${!confirming ? sql`UNION ALL SELECT region,aws_account_id,kind,true,false,NULL,NULL FROM provider_feedback_history WHERE topic_arn=${arn}` : sql``} ORDER BY ready DESC LIMIT 1`)).rows[0];
    if (!binding || !arn.startsWith(`arn:aws:sns:${binding.region}:${binding.aws_account_id}:`)) return;
    // A pending topic may confirm its subscription but must never prime trust for notifications.
    if (!binding.ready) return confirming ? binding : undefined;
    if (binding.inbound && binding.kind==='byo') return binding; // A reconnect must not inherit cached receipt trust.
    if (sendingTopics.size >= 1024) sendingTopics.delete(sendingTopics.keys().next().value!);
    sendingTopics.set(arn, { binding, expires: Date.now() + 60_000 });
    return binding;
  }
  const snsText: Parameters<App['use']>[1] = async (c, next) => {
    // SNS sends JSON envelopes as text/plain. Normalize only the media type before
    // OpenAPI's required JSON validator; preserve the signed envelope bytes.
    if (c.req.method === 'POST' && c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/plain') {
      const headers = new Headers(c.req.raw.headers);
      headers.set('content-type', 'application/json');
      c.req.raw = new Request(c.req.raw, { headers });
    }
    await next();
  };
  app.use('/v1/events/ses', snsText);
  app.use('/v1/events/cloudformation', snsText);
  // Connected AWS accounts' stacks (api/byo-templates/) report through the platform's setup topic.
  app.openapi(createRoute({ method: 'post', path: '/v1/events/cloudformation', operationId: 'receiveCloudFormationSnsEvent', tags: ['Events'], security: [], description: 'CloudFormation requests from connected AWS accounts\' role stacks, delivered by SNS from the platform\'s setup topic. AWS-signed ingress only.', request: { body: { required: true, content: { 'application/json': { schema: snsSchema }, 'text/plain': { schema: z.string().openapi('SnsPlainTextEnvelope') } } } }, responses: { 202: response(SnsAccepted), ...errors } }), async c => {
    let raw: unknown; try { raw = JSON.parse(await c.req.text()); } catch { throw new ApiError(400, 'SNS_INVALID_ENVELOPE', 'Expected an SNS JSON envelope.'); }
    const parsed = snsSchema.safeParse(raw); if (!parsed.success) throw new ApiError(400, 'SNS_INVALID_ENVELOPE', 'Expected a complete signed SNS envelope.');
    const envelope = parsed.data, trusted = await verifySns(envelope, c.env, c.req.header(clientIpHeader) ?? 'unknown'), account = c.env.config.platformAccount;
    if (!c.env.config.multiTenant || !account || envelope.TopicArn !== `arn:aws:sns:us-east-2:${account}:nightmail-byo-setup`) throw new ApiError(403, 'SNS_TOPIC_NOT_ALLOWED', 'Only the platform\'s stack topic is accepted here.');
    if (envelope.Type === 'SubscriptionConfirmation') {
      const url = trustedSnsUrl(envelope.SubscribeURL!, trusted.host, false);
      if (url.searchParams.get('Action') !== 'ConfirmSubscription' || url.searchParams.get('TopicArn') !== envelope.TopicArn || url.searchParams.get('Token') !== envelope.Token || url.searchParams.size !== 3) throw new ApiError(403, 'SNS_UNTRUSTED_URL', 'SNS confirmation fields differ.');
      const result = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) }); await result.body?.cancel();
      if (!result.ok) throw new ApiError(503, 'SNS_CONFIRMATION_FAILED', 'SNS did not confirm the subscription.', undefined, true);
      return c.json({ accepted: true }, 202);
    }
    if (envelope.Type !== 'Notification') return c.json({ accepted: false }, 202);
    if (await (await wrapModuleLoad(() => import('../byo-regional.js'))).stackNotification(c.env, envelope.Message)) try { await c.env.wake?.(1); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED' }); }
    return c.json({ accepted: true }, 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/events/ses', operationId: 'receiveSesSnsEvent', tags: ['Events'], security: [], request: { body: { required: true, content: { 'application/json': { schema: snsSchema }, 'text/plain': { schema: z.string().openapi('SnsPlainTextEnvelope') } } } }, responses: { 202: response(SnsAccepted), ...errors } }), async c => {
    let raw: unknown; try { raw = JSON.parse(await c.req.text()); } catch { throw new ApiError(400, 'SNS_INVALID_ENVELOPE', 'Expected an SNS JSON envelope.'); }
    const parsed = snsSchema.safeParse(raw); if (!parsed.success) throw new ApiError(400, 'SNS_INVALID_ENVELOPE', 'Expected a complete signed SNS envelope.');
    const envelope = parsed.data;
    // Prove AWS signed this exact topic before looking up its tenant. A valid
    // signature is NOT topic authorization: all binding checks below still apply.
    // Both entry points overwrite this header with the socket/edge peer (IPv6 /64).
    const trusted = await verifySns(envelope, c.env, c.req.header(clientIpHeader) ?? 'unknown');
    // Region settings may come from a 30 s cache: a topic or account provisioned since then is re-checked fresh.
    let stack: Awaited<ReturnType<typeof import('../provider-connections.js').byoStackTopic>>;
    let binding:TopicBinding|undefined;
    if (c.env.config.multiTenant && envelope.Type==='SubscriptionConfirmation' && c.env.config.platformAccount) {
      const account=c.env.config.platformAccount, region=trusted.region;
      const names=region==='us-east-2'?['nightmail-inbound','nightmail-feedback']:region==='us-east-1'?['nightmail-trusted-feedback']:[];
      if(names.some(n=>envelope.TopicArn===`arn:aws:sns:${region}:${account}:${n}`)) {
        const url=trustedSnsUrl(envelope.SubscribeURL!,trusted.host,false);
        if(url.searchParams.get('Action')!=='ConfirmSubscription'||url.searchParams.get('TopicArn')!==envelope.TopicArn||url.searchParams.get('Token')!==envelope.Token||url.searchParams.size!==3) throw new ApiError(403,'SNS_UNTRUSTED_URL','SNS confirmation fields differ.');
        const matched=await c.env.db.transaction(async tx=>{
          const fence=sql`topic_arn=${envelope.TopicArn} AND account_id=${account} AND region=${region} AND endpoint=${feedbackUrl(c.env.config)} AND expires_at>now()`;
          const row=(await tx.execute<{confirmation_id:string|null}>(sql`SELECT confirmation_id FROM hosted_topic_cutover WHERE ${fence} FOR UPDATE`)).rows[0];
          if(!row)return false;
          if(row.confirmation_id===envelope.MessageId)return true;
          const result=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(8000)});await result.body?.cancel();
          if(!result.ok)throw new ApiError(503,'SNS_CONFIRMATION_FAILED','SNS did not confirm the prepared subscription.',undefined,true);
          await tx.execute(sql`UPDATE hosted_topic_cutover SET confirmed_at=clock_timestamp(),confirmation_id=${envelope.MessageId} WHERE ${fence}`);return true;
        });
        if(matched)return c.json({accepted:true},202);
      }
    }
    if (c.env.config.multiTenant) {
      if (envelope.Type==='SubscriptionConfirmation') stack=await (await wrapModuleLoad(() => import('../provider-connections.js'))).byoStackTopic(c.env,envelope.TopicArn);
      binding=stack ? undefined : await sendingTopic(c.env,envelope.TopicArn,envelope.Type==='SubscriptionConfirmation');
      if (!stack && !binding) throw new ApiError(403,'SNS_TOPIC_NOT_ALLOWED','This SNS topic is not registered for the account and region.');
      c.env={...c.env,config:{...c.env.config,snsTopicArns:[envelope.TopicArn],inboundTopicArns:binding?.inbound?[envelope.TopicArn]:[]}};
    } else {
      c.env = await resolveRegionRuntime(c.env, { cacheMs: 30_000 });
      if (!c.env.config.snsTopicArns.includes(envelope.TopicArn)) c.env = await resolveRegionRuntime(c.env);
      if (!c.env.config.snsTopicArns.includes(envelope.TopicArn)) throw new ApiError(403, 'SNS_TOPIC_NOT_ALLOWED', 'The SNS topic is not configured for this deployment.');
    }
    if (envelope.Type !== 'Notification') {
      if (envelope.Type === 'SubscriptionConfirmation') {
        const url = trustedSnsUrl(envelope.SubscribeURL!, trusted.host, false);
        if (url.searchParams.get('Action') !== 'ConfirmSubscription' || url.searchParams.get('TopicArn') !== envelope.TopicArn || url.searchParams.get('Token') !== envelope.Token || url.searchParams.size!==3) throw new ApiError(403, 'SNS_UNTRUSTED_URL', 'SNS confirmation URL fields do not match the signed envelope.');
        const confirm = async () => {
          const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(stack ? 4000 : 10000) }); await res.body?.cancel(); if (!res.ok) throw new ApiError(503, 'SNS_CONFIRMATION_FAILED', 'SNS subscription confirmation failed.', undefined, true);
        };
        if (stack) {
          try { await stack({messageId:envelope.MessageId,confirm}); }
          catch (e) {
            if (e instanceof ModuleLoadError) throw e;
            const error=awsError(e);
            // IAM propagation and racing callbacks can precede a usable role; SNS retries 5xx, not 409/403.
            if (error.retryable || error.code==='AWS_ACCESS_DENIED') throw new ApiError(503,error.code,error.message,undefined,true);
            throw error;
          }
        } else if (binding?.kind==='shared' && binding.managed_id==='pool') {
          if (!c.env.config.trustedPool || binding.ready) throw new ApiError(403,'SNS_TOPIC_NOT_ALLOWED','No pending trusted subscription.');
          const fence=sql`region=${binding.region} AND aws_account_id=${binding.aws_account_id} AND NOT legacy_names AND pool_tier='trusted' AND generation=${binding.generation} AND feedback_topic_arn=${envelope.TopicArn} AND sending_state='pending'`;
          await c.env.db.transaction(async db=>{
            if (!(await db.execute(sql`SELECT FROM provider_pool_regions WHERE ${fence} FOR UPDATE`)).rowCount) throw new ApiError(503,'PROVISION_LEASE_LOST','Pool confirmation raced setup; retry.',undefined,true);
            await confirm();await db.execute(sql`UPDATE provider_pool_regions SET confirmed_generation=generation WHERE ${fence}`);
          });
        } else if (binding?.managed_id && !binding.ready) {
          const fence=sql`connection_id=${binding.managed_id} AND region=${binding.region} AND generation=${binding.generation} AND feedback_topic_arn=${envelope.TopicArn} AND sending_state='provisioning'`;
          // Lock only this topic generation across the bounded confirmation GET. If
          // it changed during signature verification, retry BEFORE consuming the token.
          await c.env.db.transaction(async db=>{
            if (!(await db.execute(sql`SELECT FROM provider_connection_regions WHERE ${fence} FOR UPDATE`)).rowCount) throw new ApiError(503,'PROVISION_LEASE_LOST','The confirmation raced a new regional setup generation. Retry the signed callback.',undefined,true);
            await confirm();await db.execute(sql`UPDATE provider_connection_regions SET confirmed_topic_arn=feedback_topic_arn,confirmed_generation=generation WHERE ${fence}`);
          });
        } else await confirm();
      }
      // An authenticated UnsubscribeConfirmation is acknowledged, never automatically resubscribed.
      return c.json({ accepted: true }, 202);
    }
    let message: unknown; try { message = JSON.parse(envelope.Message); } catch { throw new ApiError(400, 'SES_INVALID_EVENT', 'SNS Message must contain a SES JSON event.'); }
    // Mailbox receipt notifications arrive on a separate Nightmail-owned topic and carry no sending account.
    if (c.env.config.inboundTopicArns?.includes(envelope.TopicArn)) {
      const {acceptInboundNotification,wakeReceivedMail}=await wrapModuleLoad(() => import('../mailbox-receipts.js'));
      const runnable = await acceptInboundNotification(c.env, { topicArn: envelope.TopicArn, region: trusted.region, message });
      try { await wakeReceivedMail(c.env,runnable); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Mailbox ingestion remains durable.' }); }
      return c.json({ accepted: true }, 202);
    }
    // An SES tenant status event (EventBridge) has no mail object: it is judged by its topic, account, region and an
    // owned tenant ARN (src/standing.ts), before the mail checks below; both ingress paths use the same check.
    const tenantEvent = c.env.config.multiTenant && (message as { source?: unknown } | null)?.source === 'aws.ses' ? (await import('../standing.js')).tenantStatusEvent(message as Record<string, unknown>) : null;
    if (tenantEvent) {
      if (binding?.kind !== 'shared') throw new ApiError(403, 'SNS_TOPIC_NOT_ALLOWED', `SES tenant status events are accepted only from a ${productName}-owned shared feedback topic.`);
      const tenantItem = { message: message as Record<string, unknown>, topicArn: envelope.TopicArn, messageId: envelope.MessageId, region: trusted.region, topicKind: 'shared' as const };
      if (c.env.feedback) { await c.env.feedback.enqueue([tenantItem]); return c.json({ accepted: true }, 202); }
      const refused = await (await import('../standing.js')).ingestTenantStatus(c.env, tenantEvent, tenantItem);
      if (refused) throw new ApiError(403, refused, `This SES tenant status event does not match a tenant ${productName} owns on this topic.`);
      return c.json({ accepted: true }, 202);
    }
    verifySesAccount(c.env, message, envelope.TopicArn);
    if (binding?.kind==='byo' && c.env.allowFeedbackTopic && !await c.env.allowFeedbackTopic(envelope.TopicArn))
      throw new ApiError(503,'FEEDBACK_TOPIC_BUSY','Feedback for this topic is temporarily rate limited; retry.',undefined,true);
    const payload = { message, topicArn: envelope.TopicArn, messageId: envelope.MessageId, region: trusted.region };
    const item = { ...payload, topicKind:binding?.kind, message: message as Record<string, unknown> };
    // With a feedback sink (Cloudflare), the verified callback leaves the request path immediately and is
    // ingested in batches by the feedback consumer; nothing here touches the database or the jobs table.
    if (c.env.feedback) {
      sesFeedbackIdentity(item.message);
      await c.env.feedback.enqueue([item]);
      return c.json({ accepted: true }, 202);
    }
    const { ingestRoutineSesEvent } = await loadSendingOps();
    const { error, runnable } = await ingestRoutineSesEvent(c.env, routineInput(item, true));
    if (error === 'SES_ACCOUNT_MISMATCH') throw new ApiError(403, error, 'The SES sending account is missing or does not match this deployment.');
    // SNS retries 5xx, not 4xx. Without a verified owner we cannot store a tenant-scoped recovery job yet.
    if (error) throw new ApiError(503, error, 'The feedback owner is not yet available; retry this notification.', undefined, true);
    if (runnable > 0) try { await c.env.wake?.(runnable,'webhook'); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Feedback recovery and webhook jobs remain durable.' }); }
    return c.json({ accepted: true }, 202);
  });
}
