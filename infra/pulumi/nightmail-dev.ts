import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import {bucketPolicy, deliveryPolicy, feedbackPolicy, FEEDBACK_EVENTS, inboundPolicy, lifecycleRules, receiptRule} from '../../api/src/mail-controls.js';
import {deadLetterAlarm} from './receiving-alarm.js';

/** Prepare a second, private mail path. Nothing here publishes events, creates a live
 * subscription, sets the active receipt set, changes an identity or issues an access key. */
export function prepareDevMail(ohio:aws.Provider,va:aws.Provider,account:string,boundary:string,policies:Record<string,unknown>,active:boolean) {
  if (pulumi.getStack()!=='dev'||account!=='905840579680'||boundary!==`arn:aws:iam::${account}:policy/bane-runtime-boundary`) throw Error('Expected the bounded dev stage');
  const keep={provider:ohio,protect:true};
  const tag=(purpose:string)=>({'nightmail:installation-id':'nightmail:pool','nightmail:owner':'nightmail','nightmail:purpose':purpose});
  const name='nightmail-runtime';
  const user=new aws.iam.User(name,{name,path:'/',permissionsBoundary:boundary,tags:tag('hosted-runtime')},{provider:va,protect:true});
  for(const [old,doc] of Object.entries(policies)) {
    // Translate only the reviewed local identity policy document, not customer data/ARNs,
    // template URLs, endpoint hostnames or the RoleSessionName expected by customer trust.
    const name=old.replace(/^bane-runtime/, 'nightmail-runtime');
    if(!/^nightmail-runtime(?:-ohio|-trusted)?$/.test(name))throw Error('Unexpected runtime policy');
    const policy=JSON.stringify(doc).replaceAll('bane-','nightmail-').replaceAll('bane:','nightmail:').replaceAll('"bane"','"nightmail"').replaceAll('/Bane-','/Nightmail-');
    if(policy.length>6144)throw Error('Renamed managed policy exceeds IAM size limit');
    const managed=new aws.iam.Policy(name,{name,policy},{provider:va,protect:true});
    new aws.iam.UserPolicyAttachment(name,{user:user.name,policyArn:managed.arn},{provider:va,protect:true});
  }
  const bucketName=`nightmail-${account}-mail-us-east-2`;
  const bucket=new aws.s3.Bucket('nightmail-mail',{bucket:bucketName,tags:tag('mailbox-inbound')},keep);
  const block=new aws.s3.BucketPublicAccessBlock('nightmail-mail-private',{bucket:bucket.id,blockPublicAcls:true,ignorePublicAcls:true,blockPublicPolicy:true,restrictPublicBuckets:true},keep);
  const policy=new aws.s3.BucketPolicy('nightmail-mail-policy',{bucket:bucket.id,policy:JSON.stringify(bucketPolicy(bucketName,'us-east-2',account,'nightmail-inbound-'))},{...keep,dependsOn:[block]});
  // Source tags remain effective on copied objects. Add the corresponding expiry rules
  // for newly tagged objects; never change object keys or reset a retention hold.
  const retention=lifecycleRules(true).map(r=>({id:r.ID.replace(/^bane-/,'nightmail-'),status:r.Status,
    filter:'Tag' in r.Filter?{tag:{key:r.Filter.Tag.Key,value:r.Filter.Tag.Value}}:{prefix:r.Filter.Prefix},
    expiration:'Expiration' in r?{days:r.Expiration.Days}:undefined,
    abortIncompleteMultipartUpload:'AbortIncompleteMultipartUpload' in r?{daysAfterInitiation:r.AbortIncompleteMultipartUpload.DaysAfterInitiation}:undefined}));
  const mirror=retention.flatMap(r=>r.filter.tag?[{...r,id:r.id+'-renamed-tag',filter:{tag:{...r.filter.tag,key:'nightmail-kind'}}}]:[]);
  new aws.s3.BucketLifecycleConfiguration('nightmail-mail-retention',{bucket:bucket.id,rules:[...retention,...mirror]},keep);
  const topics=new Map<string,aws.sns.Topic>();
  for(const [provider,region] of [[ohio,'us-east-2'],[va,'us-east-1']] as const){
    const opts={provider,protect:true};const pager=new aws.sns.Topic(`nightmail-alerts-${region}`,{name:'nightmail-alerts',tags:tag('alerts')},opts);
    for(const name of region==='us-east-2'?['nightmail-inbound','nightmail-feedback']:['nightmail-trusted-feedback']) {
      const arn=`arn:aws:sns:${region}:${account}:${name}`, inbound=name==='nightmail-inbound';
      const prefix=region==='us-east-1'?'nightmail-trusted':'nightmail';
      const sets=['transactional','marketing'].map(stream=>`${prefix}-${stream}`);
      const topic=new aws.sns.Topic(name,{name,tags:tag(inbound?'mailbox-inbound':'ses-feedback'),deliveryPolicy:JSON.stringify(deliveryPolicy),
        policy:JSON.stringify(inbound?inboundPolicy(arn,region,account,'nightmail-inbound-'):feedbackPolicy(account,{topic:arn,sets:sets.map(set=>`arn:aws:ses:${region}:${account}:configuration-set/${set}`)},active))},opts);
      if(active&&!inbound) for(const set of sets) new aws.sesv2.ConfigurationSetEventDestination(`${set}-events`,{configurationSetName:set,eventDestinationName:`${prefix}-events`,eventDestination:{enabled:true,matchingEventTypes:[...FEEDBACK_EVENTS],snsDestination:{topicArn:topic.arn}}},opts);
      topics.set(name,topic);
      const dlqName=name+'-dead-letters';
      const queue=new aws.sqs.Queue(dlqName,{name:dlqName,sqsManagedSseEnabled:true,messageRetentionSeconds:86400*(inbound?3:14),tags:tag('dead-letters')},opts);
      new aws.sqs.QueuePolicy(dlqName+'-policy',{queueUrl:queue.url,policy:pulumi.jsonStringify({Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'sns.amazonaws.com'},Action:'sqs:SendMessage',Resource:queue.arn,Condition:{ArnEquals:{'aws:SourceArn':topic.arn},StringEquals:{'aws:SourceAccount':account}}}]})},opts);
      new aws.cloudwatch.MetricAlarm(dlqName,{...deadLetterAlarm(account,region,dlqName,queue.name,`arn:aws:sns:${region}:${account}:nightmail-alerts`),alarmActions:[pager.arn]},opts);
    }
  }
  const set=new aws.ses.ReceiptRuleSet('nightmail-inbound',{ruleSetName:'nightmail-inbound'},keep);
  const inbound=topics.get('nightmail-inbound')!;
  const rule=receiptRule('nightmail-inbound-all',[],{bucket:bucketName,topicArn:`arn:aws:sns:us-east-2:${account}:nightmail-inbound`});
  new aws.ses.ReceiptRule('nightmail-inbound-all',{ruleSetName:set.ruleSetName,name:rule.Name,enabled:rule.Enabled,scanEnabled:rule.ScanEnabled,tlsPolicy:rule.TlsPolicy,
    s3Actions:[{position:1,bucketName:bucket.bucket,objectKeyPrefix:rule.Actions[0].S3Action.ObjectKeyPrefix,topicArn:inbound.arn}]},{...keep,dependsOn:[policy]});
  return active ? new aws.iam.AccessKey('nightmail-runtime-key',{user:user.name},{provider:va,protect:true}) : undefined;
}
