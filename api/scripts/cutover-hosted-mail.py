"""Switch exact operator-verified SES/S3 pointers; no changes to mail contents or signed events.

Requires boto3, psycopg and a libpq service/environment for the intended branch. No DDL.
Run first without --apply. Run with --apply only with old writers fenced and objects synced.
"""
import argparse, json, re
import boto3, psycopg
from psycopg import sql

p=argparse.ArgumentParser(description=__doc__);p.add_argument('--stage',choices=['dev','production'],required=True);p.add_argument('--apply',action='store_true');p.add_argument('--reverse',action='store_true');args=p.parse_args()
account={'dev':'905840579680','production':'009882681002'}[args.stage];session=boto3.Session(profile_name='bane-'+args.stage)
assert session.client('sts').get_caller_identity()['Account']==account
src,dst=('nightmail','bane') if args.reverse else ('bane','nightmail')
oh='us-east-2';srcbucket=f'{src}-{account}-mail-{oh}';dstbucket=f'{dst}-{account}-mail-{oh}'
ses=session.client('ses',region_name=oh);active=ses.describe_active_receipt_rule_set()['Metadata']['Name'];assert active in [src+'-inbound',dst+'-inbound']
topic=lambda region,name:f'arn:aws:sns:{region}:{account}:{name}'
srcin=topic(oh,src+'-inbound');dstin=topic(oh,dst+'-inbound')
origin='https://dev.bane.mx' if args.stage=='dev' else 'https://bane.mx'
def change_prefix(value,region):
    """Map only ARN fields for the two exact configuration sets and the regional feedback topic."""
    pref=src+('-trusted' if region=='us-east-1' else '');new=dst+('-trusted' if region=='us-east-1' else '')
    pairs={topic(region,pref+'-feedback'):topic(region,new+'-feedback')}
    for stream in ('transactional','marketing'):
        a=f'arn:aws:ses:{region}:{account}:configuration-set/{pref}-{stream}'; b=f'arn:aws:ses:{region}:{account}:configuration-set/{new}-{stream}';pairs[a]=b;pairs[a+'/'+pref+'-events']=b+'/'+new+'-events'
    return [{**entry,**{k:pairs.get(entry[k],entry[k]) for k in ('resource','target') if k in entry}} for entry in value]
with psycopg.connect('') as c:
    c.execute("set local lock_timeout='5s'"); c.execute("set local statement_timeout='60s'");assert c.execute('select pg_try_advisory_xact_lock(78291344)').fetchone()[0]
    pools=list(c.execute('select region,aws_account_id,inbound_bucket,feedback_topic_arn,ownership_journal from provider_pool_regions order by region for update'));assert len(pools)==2 and all(row[1]==account for row in pools)
    assert not c.execute("select from mailbox_regions m join provider_connections c using(workspace_id) where c.kind='byo' and (m.bucket=%s or m.topic_arn=%s)",(srcbucket,srcin)).fetchall()
    assert not c.execute("select from jobs where type like 'mailbox.%%' and status='running' and lease_until>now()").fetchall(),'wait for active ingest leases'
    for reg,_,bucket,feedback,journal in pools:
        tier='trusted' if reg=='us-east-1' else 'probation';oldpre=src+('-trusted' if tier=='trusted' else ''); newpre=dst+('-trusted' if tier=='trusted' else '')
        oldtopic,newtopic=topic(reg,oldpre+'-feedback'),topic(reg,newpre+'-feedback');assert feedback==oldtopic and (reg!=oh or bucket==srcbucket)
        sns=session.client('sns',region_name=reg);sc=session.client('sesv2',region_name=reg)
        for n in [newtopic]+([dstin] if reg==oh else []):
            subs=sns.list_subscriptions_by_topic(TopicArn=n)['Subscriptions'];assert len(subs)==1 and subs[0]['Owner']==account and subs[0]['Endpoint']==origin+'/v1/events/ses' and subs[0]['SubscriptionArn'].startswith(n+':'); att=sns.get_subscription_attributes(SubscriptionArn=subs[0]['SubscriptionArn'])['Attributes'];assert att['PendingConfirmation']=='false' and att['RawMessageDelivery']=='false' and json.loads(att['RedrivePolicy'])['deadLetterTargetArn']==n.replace(':sns:',':sqs:')+'-dead-letters'
            if not args.reverse: assert c.execute('select from hosted_topic_cutover where topic_arn=%s and endpoint=%s and account_id=%s and region=%s and confirmed_at is not null and confirmation_id is not null',(n,origin+'/v1/events/ses',account,reg)).fetchone() is not None
        if reg==oh: rows=list(c.execute("select id,workspace_id,pool_tenant_name from provider_connections where kind='shared' and region=%s and aws_account_id=%s for update",(reg,account)))
        else: rows=list(c.execute("select c.id,c.workspace_id,r.pool_tenant_name from provider_connection_regions r join provider_connections c on r.connection_id=c.id where c.kind='shared' and r.region=%s and c.aws_account_id=%s for update of r",(reg,account)))
        for cid,wid,oldname in rows:
            assert re.fullmatch('ws_[0-9a-f]{32}',wid) and oldname==f'{src}-{tier}-{wid}'
            newname=f'{dst}-{tier}-{wid}';old=sc.get_tenant(TenantName=oldname)['Tenant'];new=sc.get_tenant(TenantName=newname)['Tenant'];assert new['TenantArn'].startswith(f'arn:aws:ses:{reg}:{account}:tenant/{newname}/') and old['SuppressionAttributes']==new['SuppressionAttributes'] and old['SendingStatus']==new['SendingStatus']
            if reg==oh:c.execute('update provider_connections set pool_tenant_name=%s where id=%s and pool_tenant_name=%s',(newname,cid,oldname))
            else:c.execute('update provider_connection_regions set pool_tenant_name=%s where connection_id=%s and region=%s and pool_tenant_name=%s',(newname,cid,reg,oldname))
            oldrow=c.execute('select arn from hosted_tenant_ownership where workspace_id=%s and region=%s for update',(wid,reg)).fetchone();assert oldrow is None or oldrow[0]==old['TenantArn']
            c.execute('insert into hosted_tenant_ownership(workspace_id,region,arn) values (%s,%s,%s) on conflict(workspace_id,region) do update set arn=excluded.arn',(wid,reg,new['TenantArn']))
            c.execute('update hosted_adoptions set tenant_arn=%s where workspace_id=%s and tenant_arn=%s',(new['TenantArn'],wid,old['TenantArn']))
        c.execute("insert into provider_feedback_history(topic_arn,region,aws_account_id,kind) values (%s,%s,%s,'shared') on conflict do nothing",(oldtopic,reg,account))
        c.execute("update provider_pool_regions set feedback_topic_arn=%s,ownership_journal=%s::jsonb,generation=generation+1,confirmed_generation=case when not legacy_names then generation+1 else confirmed_generation end where aws_account_id=%s and region=%s",(newtopic,json.dumps(change_prefix(journal,reg)),account,reg))
    changed={}
    for table,col in [('mail_messages','raw_bucket'),('mail_attachments','bucket'),('mail_candidate_uploads','bucket'),('mail_ignored_staging','bucket'),('mail_receipts','bucket')]:
        changed[table]=c.execute(sql.SQL('update {} set {}=%s where {}=%s').format(sql.Identifier(table),sql.Identifier(col),sql.Identifier(col)),(dstbucket,srcbucket)).rowcount
    c.execute('update mail_receipt_holds set bucket=%s,topic_arn=%s where bucket=%s and topic_arn=%s and region=%s and binding_workspace is null',(dstbucket,dstin,srcbucket,srcin,oh))
    c.execute("update jobs set payload=payload||jsonb_build_object('bucket',%s::text,'topic',%s::text) where status in ('pending','running') and type in ('mailbox.sweepStaging','mailbox.recoverStaging') and payload @> %s::jsonb",(dstbucket,dstin,json.dumps({'bucket':srcbucket,'topic':srcin,'shared':True})))
    c.execute('update mailbox_regions set bucket=%s,topic_arn=%s,rule_set_name=%s where account_id=%s and region=%s and bucket=%s and topic_arn=%s',(dstbucket,dstin,dst+'-inbound',account,oh,srcbucket,srcin))
    assert c.execute('update provider_pool_regions set inbound_bucket=%s,inbound_topic_arn=%s where region=%s and aws_account_id=%s and inbound_topic_arn=%s and inbound_bucket=%s',(dstbucket,dstin,oh,account,srcin,srcbucket)).rowcount==1
    # Historical sends/receipts retain the original signed topic and idempotency keys.
    print('exact pointer changes:',changed,'commit' if args.apply else 'rollback')
    if not args.apply:c.rollback()
