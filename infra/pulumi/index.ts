import * as aws from "@pulumi/aws";
import * as cf from "@pulumi/cloudflare";
import * as cfV5 from "@pulumi/cloudflare-v5";
import * as pulumi from "@pulumi/pulumi";
import { render } from "../aws-shared/runtime-policies.mjs";
import { byoBroker } from "./byo-broker.js";
import { byoSetup } from "./byo-setup.js";
import { mailGateway } from "./mail-gateway.js";
import { productionMailLifecycle } from "./live-mail-retention.js";
import {prepareDevMail,prepareProductionMail,prepareRuntime} from './nightmail-dev.js';
import { deadLetterAlarm, receivingAlarm } from './receiving-alarm.js';
import { bucketPolicy, deliveryPolicy, feedbackPolicy, inboundPolicy, lifecycleRules, POOL_STREAMS, poolEventDestination, publicAccessBlock, receiptRule, redrivePolicy } from '../../api/src/mail-controls.js';

// origin is the stage's API host: the gateway calls it, and the nightmail-runtime policies allow sns:Subscribe only to
// its /v1/events/ses (the nightmail-* topics' subscriptions are made by hand). The legacy bane-* topics' subscriptions,
// bane-runtime policies and gateway stay on legacyOrigin: a new endpoint would replace those protected subscriptions.
const stages = {
  dev: {
    account: "905840579680", origin: "https://dev.nightmail.dev", legacyOrigin: "https://dev.bane.mx", prefix: "bane-dev", worker: "bane-dev",
    cloudflareAccountId: "d8e944f537ceef3f06a5bd3aec1d7a53",
    // The homepage's media host, in the stage's own zone, and the dashboard origins that read it.
    media: { domain: "media.dev.nightmail.dev", zoneId: "941e50c6e0700a28f6f1c5224f165e31", origins: ["https://dev.nightmail.dev", "https://dev.bane.mx"] },
    queues: { work: "b2a85efa75214d8291a61eb0bf4c608a", feedback: "002ff3b09e2040d6a1fe09fa13e36387" },
    extraQueues: { webhooks: "a25aa21928d846c4a5531b7e523901a8", "feedback-dlq": "94a4269c23644e93851be3b28bb55b72" } as Record<string, string>,
  },
  production: {
    account: "009882681002", origin: "https://nightmail.dev", legacyOrigin: "https://bane.mx", prefix: "bane-prod", worker: "bane-production",
    cloudflareAccountId: "15d29c8639fd3733b1b5486a2acfd968",
    media: { domain: "media.nightmail.dev", zoneId: "bf500df4b73f1a5182243551e85019ee", origins: ["https://nightmail.dev", "https://bane.mx"] },
    queues: { work: "753a4b880016464c833b836a63663684", feedback: "34426f99502941fbbed927a059517b7c" },
    extraQueues: {} as Record<string, string>,
  },
};

const stack = pulumi.getStack();
if (stack !== "dev" && stack !== "production") throw new Error(`Unsupported Bane stack: ${stack}`);
const stage = stages[stack];
const production = stack === "production";
const config = new pulumi.Config("bane");
const nightmailCloud = config.getBoolean("nightmailCloud") === true;
const cloudPrefix = production ? 'nightmail-prod' : 'nightmail-dev';
const queuePrefix = nightmailCloud ? cloudPrefix : stage.prefix;

const roleArn = config.require("deployRoleArn");
if (!roleArn.startsWith(`arn:aws:iam::${stage.account}:role/`)) {
  throw new Error(`bane:deployRoleArn must identify a role in the ${stack} account`);
}
const permissionsBoundary = config.get("permissionsBoundary");
const writeWorkerSecrets = config.getBoolean("writeWorkerSecrets") ?? !production;

function adopt(id: string, provider: pulumi.ProviderResource): pulumi.CustomResourceOptions {
  return { import: id, protect: true, provider }; // Dropping one would take its stage down.
}

const cloudflareAccountId = stage.cloudflareAccountId;
const cloudflare = new cf.Provider("cloudflare", {}); // CLOUDFLARE_API_TOKEN
for (const [purpose, queueId] of Object.entries(stage.queues)) {
  new cf.Queue(purpose, { accountId: cloudflareAccountId, queueName: `${queuePrefix}-${purpose}` }, {
    ...adopt(`${cloudflareAccountId}/${queueId}`, cloudflare), ignoreChanges: ["settings"],
  });
}
// Queue settings (including retention) use installation defaults. Both feedback DLQs have
// archive-only Worker consumers; operators replay only from the authenticated quarantine records.
// feedback-v2 is the tagged feedback lane the Worker writes to; the original feedback queue
// stays as the legacy lane until drained (api/wrangler.<stage>.jsonc).
for (const purpose of ['webhooks','feedback-dlq','feedback-v2','feedback-priority','feedback-v2-dlq']) {
  const id = stage.extraQueues?.[purpose];
  new cf.Queue(purpose, { accountId: cloudflareAccountId, queueName: `${queuePrefix}-${purpose}` }, {
    ...(id ? adopt(`${cloudflareAccountId}/${id}`, cloudflare) : { provider: cloudflare, protect: true }),
  });
}
// The second classifier in the content screen's shadow (api/src/screen-shadow.ts): each message is one request the
// screen made, text included, waiting for the Worker's consumer. An experiment: not protected, so taking it out of the
// Worker's config and then from here removes it, and a message nobody consumed is gone after ten minutes.
new cf.Queue('jevf', { accountId: cloudflareAccountId, queueName: `${queuePrefix}-jevf`, settings: { messageRetentionPeriod: 600 } }, { provider: cloudflare });
const bucket = `${stage.prefix}-attachments`;
// Both buckets already hold attachments; adopt each in its stage's account.
new cf.R2Bucket("attachments", { accountId: cloudflareAccountId, name: bucket, jurisdiction: "default", storageClass: "Standard" }, {
  ...adopt(`${cloudflareAccountId}/${bucket}/default`, cloudflare), ignoreChanges: ["location"],
});

// Hosted received mail (raw MIME and files) once BANE_MAIL_STORE=r2; agent inbox mail always.
// Keys start with their class: d/ default (raw kept 90 days, as in
// S3), a/ attachments (no expiry, as today), e/ agent inboxes (the app erases them; 45 days is
// the backstop past the 30-day lease plus 7 days of grace), k/ kept mail (phase 2, app-managed).
const mailBucket = `${stage.prefix}-mail`;
const mailR2 = new cf.R2Bucket("mail", { accountId: cloudflareAccountId, name: mailBucket, jurisdiction: "default", location: "enam", storageClass: "Standard" }, {
  ...(production ? { provider: cloudflare, protect: true } : adopt(`${cloudflareAccountId}/${mailBucket}/default`, cloudflare)),
  ignoreChanges: ["location"], // Creation-only, like attachments.
});
const day = 86400;
new cf.R2BucketLifecycle("mail-lifecycle", { accountId: cloudflareAccountId, bucketName: mailR2.name, jurisdiction: "default", rules: [
  { id: "default-raw-90d", enabled: true, conditions: { prefix: "d/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 90 * day } } },
  { id: "ephemeral-safety-45d", enabled: true, conditions: { prefix: "e/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 45 * day } } },
  { id: "abort-multipart-1d", enabled: true, conditions: { prefix: "" }, abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: day } } },
] }, { provider: cloudflare, protect: true });

// The homepage's render sets, public at the stage's media host (the Worker's build points the page at it:
// .github/workflows/deploy.yml). app/scripts/factory-media.mjs uploads each version under factory/<version>/, the desktop
// and phone formats in it, with a year's immutable Cache-Control and then rewrites factory/current.json (a minute's), which names the version the
// page plays; old versions stay for rollback. Only that pointer is fetched by script, so CORS allows GET and HEAD from
// the stage's dashboard origins; video and images need none. No r2.dev URL: the custom domain is the only public way in.
const mediaR2 = new cf.R2Bucket("media", { accountId: cloudflareAccountId, name: `${cloudPrefix}-media`, jurisdiction: "default", location: "enam", storageClass: "Standard" }, {
  provider: cloudflare, protect: true, ignoreChanges: ["location"],
});
new cf.R2CustomDomain("media-domain", {
  accountId: cloudflareAccountId, bucketName: mediaR2.name, jurisdiction: "default", domain: stage.media.domain, zoneId: stage.media.zoneId, enabled: true, minTls: "1.2",
}, { provider: cloudflare });
new cf.R2BucketCors("media-cors", { accountId: cloudflareAccountId, bucketName: mediaR2.name, jurisdiction: "default", rules: [
  { id: "dashboard-read", allowed: { methods: ["GET", "HEAD"], origins: stage.media.origins }, maxAgeSeconds: 86400 },
] }, { provider: cloudflare });
new cf.R2BucketLifecycle("media-lifecycle", { accountId: cloudflareAccountId, bucketName: mediaR2.name, jurisdiction: "default", rules: [
  { id: "abort-multipart-1d", enabled: true, conditions: { prefix: "" }, abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: day } } },
] }, { provider: cloudflare });
export const mediaUrl = `https://${stage.media.domain}/factory/`;

// Dashboard usage analytics (docs/analytics.md), bound to the Worker as ANALYTICS. The Worker writes raw batches under
// analytics/v1/raw/ and its hourly upkeep compacts them into analytics/v1/events/ and deletes days past 400. These rules
// are the backstop: raw batches a compaction never reached go after 30 days, everything after 400.
const analyticsR2 = new cf.R2Bucket("analytics", { accountId: cloudflareAccountId, name: `${cloudPrefix}-analytics`, jurisdiction: "default", location: "enam", storageClass: "Standard" }, {
  provider: cloudflare, protect: true, ignoreChanges: ["location"],
});
new cf.R2BucketLifecycle("analytics-lifecycle", { accountId: cloudflareAccountId, bucketName: analyticsR2.name, jurisdiction: "default", rules: [
  { id: "analytics-salts-1d", enabled: true, conditions: { prefix: "analytics/v1/salts/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: day } } },
  { id: "raw-30d", enabled: true, conditions: { prefix: "analytics/v1/raw/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 30 * day } } },
  { id: "events-400d", enabled: true, conditions: { prefix: "analytics/v1/events/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 400 * day } } },
  { id: "abort-multipart-1d", enabled: true, conditions: { prefix: "" }, abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: day } } },
] }, { provider: cloudflare });

// Keep existing R2 resources protected under the original URNs. Adopt the standby pair in
// addition; changing either existing physical name would request a bucket replacement.
if (nightmailCloud) {
  for (const purpose of ['mail', 'attachments']) {
    const name = `${cloudPrefix}-${purpose}`;
    const liveBucket = new cf.R2Bucket(`nightmail-${purpose}`, { accountId: cloudflareAccountId, name, jurisdiction: 'default', storageClass: 'Standard' }, {
      ...adopt(`${cloudflareAccountId}/${name}/default`, cloudflare), ignoreChanges: ['location'],
    });
    if (production && purpose === 'mail') productionMailLifecycle(cloudflareAccountId, liveBucket.name, cloudflare);
  }
}

// The Hyperdrive config is not managed here. Cloudflare never returns origin.password, and
// Pulumi fails to import the resource because the read state lacks that required property.

const credentials = { allowedAccountIds: [stage.account], assumeRoles: [{ roleArn }] };
const iam = new aws.Provider("virginia", { ...credentials, region: "us-east-1" });
const ohio = new aws.Provider("ohio-receiving", { ...credentials, region: "us-east-2" });
const deadLetters = new aws.sqs.Queue("receiving-dead-letters", { name: "bane-inbound-dead-letters", sqsManagedSseEnabled: true,
  // The original staging object is recoverable for three days. No extension of mail retention.
  messageRetentionSeconds: 3 * 86400 }, { provider: ohio, protect: true });
new aws.cloudwatch.MetricAlarm('receiving-dead-letter-alarm', receivingAlarm(stage.account,deadLetters.name,config.require('receivingAlarmTopicArn')), {provider:ohio,protect:true});
const queuePolicy = new aws.sqs.QueuePolicy("receiving-dead-letter-policy", {queueUrl:deadLetters.url,policy:deadLetters.arn.apply(arn=>JSON.stringify({Version:"2012-10-17",Statement:[{
  Effect:"Allow",Principal:{Service:"sns.amazonaws.com"},Action:"sqs:SendMessage",Resource:arn,Condition:{ArnEquals:{"aws:SourceArn":`arn:aws:sns:us-east-2:${stage.account}:bane-inbound`},StringEquals:{"aws:SourceAccount":stage.account}}
}]}))},{provider:ohio});

// The inventory is gathered once, from the exact account, before taking over from
// the old Worker. Never infer absence from a failed AWS read, or replace a live route.
const imports = config.requireObject<string[]>('mailControlImports');
const account = stage.account, region = 'us-east-2', bucketName = `bane-${account}-mail-${region}`;
const inboundArn = `arn:aws:sns:${region}:${account}:bane-inbound`;
const opts = (id:string,provider:pulumi.ProviderResource) => imports.includes(id)?adopt(id,provider):{provider,protect:true};
const tags = (purpose:string) => ({'bane:installation-id':'bane:pool','bane:purpose':purpose});
export const mailGatewayEndpoint = mailGateway(stack, stage, config, ohio, iam, cloudflare, tags("mail-gateway"));
export const nightmailGatewayEndpoint = config.getBoolean('nightmailGateway') ? mailGateway(stack,stage,config,ohio,iam,cloudflare,{'nightmail:installation-id':'nightmail:pool','nightmail:purpose':'mail-gateway'},true) : undefined;
const mail = new aws.s3.Bucket('pool-mail',{bucket:bucketName,tags:tags('mailbox-inbound')},opts(bucketName,ohio));
const protectedOhio = {provider:ohio,protect:true};
const block = new aws.s3.BucketPublicAccessBlock('pool-mail-private',{bucket:mail.id,blockPublicAcls:publicAccessBlock.BlockPublicAcls,
  ignorePublicAcls:publicAccessBlock.IgnorePublicAcls,blockPublicPolicy:publicAccessBlock.BlockPublicPolicy,restrictPublicBuckets:publicAccessBlock.RestrictPublicBuckets},protectedOhio);
const access = new aws.s3.BucketPolicy('pool-mail-policy',{bucket:mail.id,policy:JSON.stringify(bucketPolicy(bucketName,region,account,'bane-inbound-'))},{...protectedOhio,dependsOn:[block]});
const lifecycle = new aws.s3.BucketLifecycleConfiguration('pool-mail-retention',{bucket:mail.id,rules:lifecycleRules(true).map(r=>({
  id:r.ID,status:r.Status,filter:'Tag' in r.Filter?{tag:{key:r.Filter.Tag.Key,value:r.Filter.Tag.Value}}:{prefix:r.Filter.Prefix},
  expiration:'Expiration' in r?{days:r.Expiration.Days}:undefined,abortIncompleteMultipartUpload:'AbortIncompleteMultipartUpload' in r?{daysAfterInitiation:r.AbortIncompleteMultipartUpload.DaysAfterInitiation}:undefined,
}))},protectedOhio);
const inbound = new aws.sns.Topic('pool-inbound',{name:'bane-inbound',tags:tags('mailbox-inbound'),policy:JSON.stringify(inboundPolicy(inboundArn,region,account,'bane-inbound-')),
  deliveryPolicy:JSON.stringify(deliveryPolicy)},opts(inboundArn,ohio));
const subArn = imports.find(id=>id.startsWith(inboundArn+':'));
if (subArn && !/^[0-9a-f-]{36}$/i.test(subArn.slice(inboundArn.length+1))) throw new Error('Import only the confirmed Bane inbound HTTPS subscription ARN');
const sub = new aws.sns.TopicSubscription('pool-inbound-https',{topic:inbound.arn,protocol:'https',endpoint:stage.legacyOrigin+'/v1/events/ses',rawMessageDelivery:false,
  endpointAutoConfirms:false,redrivePolicy:JSON.stringify(redrivePolicy(region,account))},{...(subArn?adopt(subArn,ohio):protectedOhio),dependsOn:[queuePolicy]});
const rule=receiptRule('bane-inbound-all',[],{bucket:bucketName,topicArn:inboundArn}), action=rule.Actions[0].S3Action;
const route = new aws.ses.ReceiptRule('pool-inbound-all',{ruleSetName:'bane-inbound',name:rule.Name,enabled:rule.Enabled,scanEnabled:rule.ScanEnabled,tlsPolicy:rule.TlsPolicy,
  recipients:rule.Recipients,s3Actions:[{position:1,bucketName:action.BucketName,objectKeyPrefix:action.ObjectKeyPrefix,topicArn:inbound.arn}]},
  {...opts('bane-inbound:bane-inbound-all',ohio),dependsOn:[access,lifecycle,sub]});
const trustedPublish=config.requireBoolean('trustedFeedbackPublish');
// Mythos 5.1 N-M3: SES bounce and complaint feedback reaches the Worker over HTTPS. SNS retries it
// with backoff for up to an hour, then dead-letters it to a queue only that topic may write, and the
// operator is paged on the first message. Alarm actions must be in the queue's region.
const pagers = [config.require('receivingAlarmTopicArn'), config.require('virginiaAlarmTopicArn')];
const feedback = [false,true].map((trusted,i)=>{
  const r=trusted?'us-east-1':region, prefix=trusted?'bane-trusted':'bane', name=prefix+'-feedback', arn=`arn:aws:sns:${r}:${account}:${name}`;
  const sets=['transactional','marketing'].map(stream=>`arn:aws:ses:${r}:${account}:configuration-set/${prefix}-${stream}`);
  const provider=trusted?iam:ohio, options={provider,protect:true};
  const topic=new aws.sns.Topic(`pool-${name}`,{name,tags:{...tags('ses-feedback'),...(trusted?{'bane:owner':'bane'}:{})},
    deliveryPolicy:JSON.stringify(deliveryPolicy),policy:JSON.stringify(feedbackPolicy(account,{topic:arn,sets},!trusted||trustedPublish))},opts(arn,provider));
  const dlq=new aws.sqs.Queue(`${name}-dead-letters`,{name:`${name}-dead-letters`,sqsManagedSseEnabled:true,messageRetentionSeconds:14*86400},options);
  new aws.cloudwatch.MetricAlarm(`${name}-dead-letter-alarm`,deadLetterAlarm(account,r,`${name}-dead-letters`,dlq.name,pagers[i]!),options);
  const policy=new aws.sqs.QueuePolicy(`${name}-dead-letter-policy`,{queueUrl:dlq.url,policy:dlq.arn.apply(queue=>JSON.stringify({Version:'2012-10-17',Statement:[{
    Effect:'Allow',Principal:{Service:'sns.amazonaws.com'},Action:'sqs:SendMessage',Resource:queue,Condition:{ArnEquals:{'aws:SourceArn':arn},StringEquals:{'aws:SourceAccount':account}}
  }]}))},{provider});
  const subscription=imports.find(id=>id.startsWith(arn+':'));
  if (subscription && !/^[0-9a-f-]{36}$/i.test(subscription.slice(arn.length+1))) throw new Error(`Import only the confirmed Bane ${name} HTTPS subscription ARN`);
  // Virginia's subscription is created and journaled by the Worker during trusted enrollment;
  // Pulumi only adopts it afterwards. Ohio's is created here if the inventory found none.
  if (subscription || !trusted) new aws.sns.TopicSubscription(`pool-${name}-https`,{topic:topic.arn,protocol:'https',endpoint:stage.legacyOrigin+'/v1/events/ses',rawMessageDelivery:false,
    endpointAutoConfirms:false,redrivePolicy:dlq.arn.apply(deadLetterTargetArn=>JSON.stringify({deadLetterTargetArn}))},{...(subscription?adopt(subscription,provider):options),dependsOn:[policy]});
  return topic;
});
// N7: the runtime key can no longer write event destinations or suppression options on the pool
// sets. An operator creates the four sets once (tenant suppression, docs/receiving-operations.md);
// Pulumi owns their destinations, Virginia's only after its signed confirmation. The Worker verifies.
const destinations = [false,true].flatMap((trusted,i)=>trusted && !trustedPublish ? [] : POOL_STREAMS.map(stream=>{
  const prefix=trusted?'bane-trusted':'bane', set=`${prefix}-${stream}`, topic=feedback[i]!, d=poolEventDestination(prefix,'');
  return new aws.sesv2.ConfigurationSetEventDestination(`pool-${set}-events`,{configurationSetName:set,eventDestinationName:d.Name,
    eventDestination:{enabled:d.Enabled,matchingEventTypes:d.MatchingEventTypes,snsDestination:{topicArn:topic.arn}}},
    {...opts(`${set}|${d.Name}`,trusted?iam:ohio),dependsOn:[topic]});
}));
const runtime = "bane-runtime";
const user = new aws.iam.User(runtime, {
  name: runtime, path: "/", tags: { "bane:purpose": "hosted-runtime" }, permissionsBoundary,
}, adopt(runtime, iam));

const policies = render("--fresh", { account: stage.account, origin: stage.origin });
const legacyPolicies = render("--fresh", { account: stage.account, origin: stage.legacyOrigin, broker: false });
export const byoBrokerArn = byoBroker(iam, stage.account);
// Off until the deploy role may manage the template bucket and setup topic (README, "Dax: one-time IAM for BYO setup").
export const byo = config.getBoolean("byoSetup") ? byoSetup(ohio, stage.account, production ? "https://events.nightmail.dev" : "https://events.dev.nightmail.dev") : undefined;
const renamedKey = !production && config.getBoolean('prepareNightmailMail') ? prepareDevMail(ohio,iam,stage.account,config.require('permissionsBoundary'),policies,config.getBoolean('nightmailMailActive')===true) : undefined;
if (production && config.getBoolean('prepareNightmailMail')) prepareProductionMail(ohio,iam,stage.account);
const standbyRuntime = production && config.getBoolean('stageNightmailRuntime');
if (standbyRuntime && !writeWorkerSecrets) throw Error('Staged production runtime requires private Worker secret delivery');
const standbyKey = standbyRuntime ? prepareRuntime(iam,stage.account,config.require('permissionsBoundary'),policies,true) : undefined;
const attachments = Object.entries(legacyPolicies).map(([name, document]) => {
  const arn = `arn:aws:iam::${stage.account}:policy/${name}`;
  const policy = new aws.iam.Policy(name, { name, path: "/", policy: JSON.stringify(document) }, {...adopt(arn, iam),dependsOn:[route,...feedback,...destinations]});
  return new aws.iam.UserPolicyAttachment(name, { user: user.name, policyArn: policy.arn }, adopt(`${runtime}/${arn}`, iam));
});

// The operator owns the active set; the Worker still manages identities, sets and tenants.

// Never import an IAM access key: AWS returns its secret only on creation.
// Keep the previous key active while old Worker versions and in-flight sends drain.
const rotation = config.get("runtimeKeyRotation");
if (rotation !== undefined && (!/^[a-z0-9-]{1,32}$/.test(rotation) || !writeWorkerSecrets)) {
  throw new Error("bane:runtimeKeyRotation needs 1-32 lowercase letters, digits or hyphens, and bane:writeWorkerSecrets");
}
const drainKey = new pulumi.ResourceHook('drain-runtime-key', async () => {
  await new Promise<void>(resolve => setTimeout(resolve, 5 * 60_000));
});
const key = new aws.iam.AccessKey(rotation ? `runtime-key-${rotation}` : "runtime-key", { user: user.name }, {
  provider: iam, dependsOn: attachments, hooks: { beforeDelete: [drainKey] },
});
if (writeWorkerSecrets) {
  // One PUT publishes one version containing the complete pair. Pulumi must
  // finish this dependent update before retiring its previous key dependency.
  const provider = new cfV5.Provider("worker-secrets", {});
  const target = { accountId: cloudflareAccountId, scriptName: stage.worker };
  new cfV5.WorkersSecret("worker-runtime-credentials", {
    ...target, name: "AWS_RUNTIME_CREDENTIALS", secretText: pulumi.secret(pulumi.jsonStringify({ accessKeyId: key.id, secretAccessKey: key.secret })),
  }, { provider, retainOnDelete: true });
  if (standbyKey) new cfV5.WorkersSecret('nightmail-production-runtime-credentials', {
    accountId: cloudflareAccountId, scriptName: 'nightmail-production', name: 'AWS_RUNTIME_CREDENTIALS',
    secretText: pulumi.secret(pulumi.jsonStringify({accessKeyId:standbyKey.id,secretAccessKey:standbyKey.secret})),
  }, { provider, retainOnDelete: true });
  if (!production && nightmailCloud) {
    // Both scripts need the old runtime credential during this CF-only switch. Never
    // rotate the IAM key, delete the old binding or move the SES receipt set here.
    new cfV5.WorkersSecret('nightmail-dev-runtime-credentials', {
      accountId: cloudflareAccountId, scriptName: 'nightmail-dev', name: 'AWS_RUNTIME_CREDENTIALS',
      secretText: pulumi.secret(pulumi.jsonStringify({ accessKeyId: (renamedKey??key).id, secretAccessKey: (renamedKey??key).secret })),
    }, { provider, retainOnDelete: true });
  }
}
