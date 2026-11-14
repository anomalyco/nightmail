#!/usr/bin/env bash
set -euo pipefail
case "$STAGE" in dev) account=905840579680;; production) account=009882681002;; *) exit 2;; esac
role=$(yq -er '.config."bane:deployRoleArn"' "infra/pulumi/Pulumi.$STAGE.yaml")
[[ $role == "arn:aws:iam::$account:role/"* ]]
aws configure set profile.tenant-check.role_arn "$role"
aws configure set profile.tenant-check.credential_source Environment
prefix=bane
if [[ $(yq -r '.config."bane:nightmailMailActive"' "infra/pulumi/Pulumi.$STAGE.yaml") == true ]]; then prefix=nightmail; fi
name=$prefix-tenant-sending-status
for region in us-east-2 us-east-1; do
  topic=$prefix-feedback
  if [[ $region == us-east-1 ]]; then
    [[ $(yq -r '.config."bane:trustedFeedbackPublish"' "infra/pulumi/Pulumi.$STAGE.yaml") == true ]] || continue
    topic=$prefix-trusted-feedback
  fi
  cmd=(aws --profile tenant-check --region "$region" events)
  "${cmd[@]}" describe-rule --name "$name" | jq -e --arg r "$region" --arg a "$account" --arg n "$name" --arg p "$prefix" '
    (.State=="ENABLED" or .State=="DISABLED") and .Arn=="arn:aws:events:\($r):\($a):rule/\($n)" and
    (.EventPattern|fromjson|(."detail-type" |= sort) | .=={source:["aws.ses"],region:[$r],account:[$a],"detail-type":["Sending Status Disabled","Sending Status Enabled"],resources:[{prefix:"arn:aws:ses:\($r):\($a):tenant/\($p)-"}]})' >/dev/null
  "${cmd[@]}" list-targets-by-rule --rule "$name" | jq -e --arg topic "arn:aws:sns:$region:$account:$topic" --arg role "arn:aws:iam::$account:role/$name-$region" '
    .Targets == [{Id:"feedback",Arn:$topic,RoleArn:$role}]' >/dev/null
done
