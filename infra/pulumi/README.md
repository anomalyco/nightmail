# Hosted Nightmail infrastructure

One project, two stacks: `dev` (AWS `905840579680`, Cloudflare `d8e944f537ceef3f06a5bd3aec1d7a53`, Worker `bane-dev`) and `production` (AWS `009882681002`, Cloudflare `15d29c8639fd3733b1b5486a2acfd968`, Worker `bane-production`). Pulumi 3.274.1 runs the TypeScript directly with `runtime: bun`; use Bun 1.3.14 and `bun install --frozen-lockfile`. Type-check with `bun run tsc --noEmit`.

## What each stack owns

The deploy role owns the Ohio mail bucket, public access block, bucket policy and lifecycle, the inbound and feedback topics, inbound HTTPS subscription/redrive, catch-all receipt rule, DLQ and alarm. It also manages the Virginia trusted feedback topic and its two-phase publish policy. [Receiving operations](../../docs/receiving-operations.md) covers required `bane:mailControlImports`, `bane:trustedFeedbackPublish` and `bane:receivingAlarmTopicArn` settings and the one-time role policy.

It also **creates** the R2 bucket for hosted received mail, `bane-<stage>-mail` (ENAM, protected), and its lifecycle rules: `d/` raw mail expires after 90 days, `e/` agent-inbox objects after 45 days as a backstop to the app’s erasure, and incomplete multipart uploads after a day. The Worker binds it as `MAIL`; see [mail-store rollout](../../docs/receiving-operations.md#mail-store-rollout-and-rollback).

It also **creates** the homepage's public media bucket, `nightmail-<stage>-media` (ENAM, protected), served only at the stage's media host (`media.dev.nightmail.dev`, `media.nightmail.dev`: an R2 custom domain in the stage's own zone, TLS 1.2+, no r2.dev URL), with CORS for `GET`/`HEAD` from the stage's dashboard origins and a one-day abort of incomplete multipart uploads. It holds render sets under `factory/<version>/` (the desktop and phone formats in `desktop/` and `phone/`) and the `factory/current.json` pointer the page reads; `app/scripts/factory-media.mjs` writes them, with each object's own `Cache-Control` (versions immutable for a year, the pointer a minute), and `.github/workflows/media.yml` promotes a version from dev to production.

It also **creates** the dashboard analytics bucket, `nightmail-<stage>-analytics` (ENAM, protected), bound to the Worker as `ANALYTICS` ([docs/analytics.md](../../docs/analytics.md)). The Worker writes and compacts it and deletes days past 400; the lifecycle rules are the backstop: `analytics/v1/raw/` after 30 days, `analytics/v1/events/` after 400, incomplete multipart uploads after a day.

It also **creates** `nightmail-byo-broker` (protected), the IAM role that assumes the roles of connected AWS accounts (bring your own AWS); see [byo-broker.ts](byo-broker.ts). Only `nightmail-runtime` may enter it, and it can do nothing but assume `Nightmail-<20>` roles outside the platform accounts. Its trust and policy come from `infra/aws-shared/runtime-policies.mjs` (`--broker`). Customer stacks name this account and the `nightmail-byo-*` role names, so never rename or delete it. The runtime can't enter it until the boundary change in [Dax: one-time boundary change for the BYO broker](#dax-one-time-boundary-change-for-the-byo-broker).

In addition to existing mail resources identified by the adoption inventory, each stack adopts these existing resources through the `import` options in [index.ts](index.ts), all with `protect: true`. Dev's queues are new in anomaly-dev and are adopted by their new ids; dev's attachments bucket is created rather than adopted:

| Owner | Resources | Import ID |
|---|---|---|
| Cloudflare (see the stage's `cloudflareAccountId`) | work and feedback queues (the webhooks, feedback-dlq and tagged `feedback-v2` queues are created, not adopted; so is `jevf`, the second classifier's queue, which alone is not protected and keeps a message ten minutes); attachments bucket (ENAM; production only) | `<account>/<queue-id>`, `<account>/<bucket>/default` |
| IAM (us-east-1 provider) | `bane-runtime` user; the `bane-runtime`, `bane-runtime-ohio` and `bane-runtime-trusted` policies and their three attachments | `bane-runtime`, policy ARN, `bane-runtime/<policy-arn>` |

**Not managed: the Hyperdrive config.** Cloudflare never returns `origin.password`, and Pulumi rejects importing it because the read state lacks that required property (`Missing required property 'origin.password'`). The live config stays as created, with caching off and 15 dev / 30 production connections; `api/wrangler.<environment>.jsonc` binds it by ID. Adopt it here once the provider can import write-only required fields.

### Runtime credentials

Each stack **creates one access key**; AWS cannot return the old key's secret. `bane:writeWorkerSecrets` defaults to **true in dev, false in production**, and `Pulumi.production.yaml` turns it on explicitly for `bane-production`. A single v5 `WorkersSecret` PUT publishes the complete key pair as `AWS_RUNTIME_CREDENTIALS`. Turning the flag off leaves the binding in place.

**Upgrade before rotating:** first deploy with `runtimeKeyRotation` unchanged. This publishes the existing pair, installs the old-key drain hook, and rolls out Worker code that prefers the bundle. The two previous bindings are retained for the upgrade; don't roll back to split-binding-only code after the first rotation. The deploy workflow excludes the access keys and Worker secret bindings from its pre-upload apply. Only after the incoming Worker version has 100% traffic does Pulumi apply those resources: on rotation it creates the new key, updates the bundle, then waits five minutes before deleting the previous key. Keep an IAM key slot free and don't overlap rotations or Worker deploys.

**Never manage here:** the Worker code, routes, Worker custom domains (including `100::` AAAAs; the media bucket's R2 custom domain is the one custom domain this stack owns), other bindings/secrets, queue consumers, or DNS records (all non-Worker DNS records, including mail gateway CNAMEs, SES DKIM and `_bane`, live in `anomalyco/platform`). The operator activates the receipt rule set, the Worker manages identities, tenants and SES configuration sets; Pulumi owns the catch-all rule inside the reviewed active set. The stack does not own state storage, deploy roles, KMS keys or the old manual IAM key.

## CI

`.github/workflows/deploy.yml` runs the Pulumi stack first in each stage's deploy, after `dev` CI passes or on a `production` push, when `infra/pulumi/**`, `infra/aws-shared/**` or the workflow changed; manual dispatches always run it, with `init` and `preview` inputs (`preview` leaves the Worker untouched). State lives in R2 (`nightmail-dev-pulumi` or `bane-production-pulumi`) and is encrypted with `alias/pulumi/nightmail-<stage>`; AWS comes from GitHub OIDC through `github/nightmail-<stage>` and the stack's `bane:deployRoleArn`. `CLOUDFLARE_API_TOKEN` is minted per run and passed through the environment only. The deploy role needs `iam:GetPolicy`, `iam:GetPolicyVersion` and `iam:ListPolicyVersions` on `policy/bane-runtime` as well as `policy/bane-runtime-*`.

Each stack settings file pins its KMS `secretsprovider`; a clean checkout needs it, or Pulumi falls back to the passphrase provider and refuses to run. `Pulumi.dev.yaml` also carries the existing stack's `encryptedkey`. After the first init of `production`, copy its generated `encryptedkey` from the stack settings into `Pulumi.production.yaml` so later runs from a clean checkout can decrypt state.

For a new stack, dispatch on `dev` with `init: true`, `preview: true`. Init creates the stack; expect the baseline imports, inventoried mail-resource imports or creates, one access-key create and one dev Worker-secret write, with zero replacements or deletes. Then run `init: true`, `preview: false` while no dev deploy or E2E is running. After the dev E2E passes on the new key, delete the old hand-made `bane-runtime` key; IAM allows only two keys per user, and a future key replacement needs the free slot. Production follows the same sequence and writes the new key to `bane-production` only; the old `opensend-mx` Worker, its secrets and its Hyperdrive are untouched.

## IMAP/SMTP gateway

[mail-gateway.ts](mail-gateway.ts) adds resources in each stage's Ohio account. No gateway image, secret values, certificate renewal job or Spectrum changes ship with this stack. **The stack cannot apply until Dax widens the stage deploy role** (policies below). A PR does not run a privileged preview: the deploy workflow accepts only the stage branch tip. Review a credentialed preview of the candidate against stage state before rollout; expect only gateway creates, no changes to existing resources.

| Setting | Default | Effect |
|---|---|---|
| `bane:mailGatewayEnabled` | `false` | The stage's gateway switch, also read by `.github/scripts/deploy-worker.sh`. When true, the Worker deploy binds `bane/<stage>/MAILGW_API_TOKEN` and stops if it is missing or malformed. When false, the deploy removes the Worker's binding. Required for a positive task count. |
| `bane:mailGatewayDesired` | `0` | Fargate ARM64 task count. No task starts or pulls the placeholder image at zero. |
| `bane:mailGatewayImage` | `bane-mail-gateway:unpublished` in the stage's ECR | Required for a positive count: use the full stage ECR URI with `@sha256:<digest>`. Immutable tags, scan on push, last 20 images kept. Keep a deployed/rollback digest within that window. |
| `bane:receivingAlarmTopicArn` | existing stack setting | Ohio `bane-alerts` SNS topic. One alarm per target group for unhealthy targets, one for elevated NLB-generated TCP resets; missing data at zero is not a breach. |

**Network and cost.** Two public subnets share an internet gateway, no NAT. Only the NLB accepts Internet TCP on 993/143/465/587. Task public IPs are for egress; the task SG admits only the NLB SG, including HTTP readiness on 8080. The cross-zone NLB preserves the peer IP (no PROXY header); the container handles implicit TLS and STARTTLS. Per stage at zero tasks and no traffic, budget **about $26/month** before free tiers: 730 × $0.0225 ≈ $16.43 for the [NLB](https://aws.amazon.com/elasticloadbalancing/pricing/), 2 × 730 × $0.005 = $7.30 for its [public IPv4s](https://aws.amazon.com/vpc/pricing/), 4 × $0.40 for [secrets](https://aws.amazon.com/secrets-manager/pricing/), 5 × $0.10 for [standard alarms](https://aws.amazon.com/cloudwatch/pricing/). No Fargate or NAT charge. NLCUs, traffic, populated ECR/log storage, API calls and notifications are extra.

### Activate without moving live traffic

1. Bootstrap IAM below; apply at zero with DNS off. In `bane/<stage>/mail-gateway/` populate `db-url`, `tls-cert` (PEM full chain), `tls-key` (matching PEM private key) and `api-token` **out of band**. The execution role injects `DATABASE_URL`, `MAILGW_CERT_PEM`, `MAILGW_KEY_PEM` and `MAILGW_API_TOKEN` at task start. The application task role has **no policies**. Never put values in stack config, the image, shell arguments, or logs. The Worker needs the same token as `bane/<stage>/MAILGW_API_TOKEN` in the secrets account; the deploy binds it while `bane:mailGatewayEnabled` is true and removes it while false ([dev runbook](../../gateway/PHASE2.md#dev-turn-on-runbook)). The task definition sets `MAILGW_API_URL` to the stack's own origin (the program fails without one, and so does the binary) and lowers `net.ipv4.ip_unprivileged_port_start` to 143 so the nonroot image can bind the mail ports on Fargate.
2. Publish the production-capable Linux/ARM64 image. It must bind all four ports on the task ENI (not loopback); return HTTP 200 on `:8080/health` only when all listeners and TLS are ready. If the binary needs cert/key paths, the entrypoint must materialize the injected PEMs in private ephemeral files (`0600`). It must drain active sessions on `SIGTERM` and exit within **120 s** (Fargate maximum); the NLB deregistration delay is **300 s**, not extra process lifetime. TCP listeners allow 1,800 s idle. Neither a fixture build nor an unpublished tag is suitable for scale-up.
3. Set the image digest and desired count; recommend two healthy tasks across AZs for production. Keep DNS off. Check healthy IPs in **all four** target groups; connect via `mailGatewayEndpoint` with the stage hostname as SNI/verification name. Verify both implicit TLS and STARTTLS (IMAP on 143, SMTP on 587), certificate SANs and a reconnect during a rolling deploy. Logs are in `/ecs/bane-mail-gateway` for 30 days. Old task definition revisions are retained; retire unused revisions separately (CI does not get account-wide deregistration).
4. **DNS cutover is a separate, coordinated change.** `imap.bane.mx` / `smtp.bane.mx` and the dev zone's `imap.dev.bane.mx` / `smtp.dev.bane.mx` currently point at Spectrum test apps. Record the old Spectrum config, records and TTL for rollback. Grant the stage CI token Zone Read and DNS Edit on its own zone; release the two conflicting names from Spectrum during the cutover window, then enable `bane:mailGatewayDns` in **that stage only**. Verify the DNS-only CNAME answers and all four TLS paths through the hostnames. If cutover fails, restore the recorded Spectrum configuration. After adoption by this stack, disabling the flag alone cannot delete protected records: explicitly unprotect and remove the two stack-owned records in a reviewed rollback before restoring Spectrum; leave the NLB running through DNS propagation.

**TLS renewal recommendation (not provisioned):** issue a stage-specific SAN certificate for both hostnames using Let's Encrypt DNS-01. A scheduled `lego` job with a separate identity can renew before 30 days remain using a zone-limited Cloudflare token, validate the key against the chain, then promote both secret versions before forcing a rolling ECS deployment. Serialize rotation and deployments so tasks cannot start with a mismatched pair; retain previous versions for rollback. ECS does not refresh injected secrets in a running task. Monitor expiry independently. Neither the gateway nor its CI deploy role needs the ACME token.

### Dax: one-time IAM for the gateway

`github/nightmail-<stage>` in the CI account assumes the role configured by `bane:deployRoleArn`: `role/nightmail-deploy` in dev and `role/bane-deploy` in production. Put the two additional deploy policies below on that **assumed role**, not on the OIDC principal or `bane-runtime`. Substitute `ACCOUNT` / `STAGE` with `905840579680` / `dev` or `009882681002` / `production` throughout (not IAM policy variables). First ensure the account has the AWS service-linked roles `AWSServiceRoleForECS` and `AWSServiceRoleForElasticLoadBalancing`; create them once as an administrator if absent. Their ENI, target registration and discovery permissions do not belong on CI. Keep existing state/KMS/assume-role policies unchanged.

**1. Stack-owned execution policy.** Pulumi creates an inline policy on the execution role with the permissions below. It uses the four secret ARNs directly; the suffixes here represent their generated identifiers. The task role has no identity policy.

```json
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":"ecr:GetAuthorizationToken","Resource":"*","Condition":{"StringEquals":{"aws:RequestedRegion":"us-east-2"}}},
  {"Effect":"Allow","Action":["ecr:BatchCheckLayerAvailability","ecr:GetDownloadUrlForLayer","ecr:BatchGetImage"],"Resource":"arn:aws:ecr:us-east-2:ACCOUNT:repository/bane-mail-gateway"},
  {"Effect":"Allow","Action":["logs:CreateLogStream","logs:PutLogEvents"],"Resource":"arn:aws:logs:us-east-2:ACCOUNT:log-group:/ecs/bane-mail-gateway:log-stream:gateway/bane-mail-gateway/*"},
  {"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":["arn:aws:secretsmanager:us-east-2:ACCOUNT:secret:bane/STAGE/mail-gateway/db-url-??????","arn:aws:secretsmanager:us-east-2:ACCOUNT:secret:bane/STAGE/mail-gateway/tls-cert-??????","arn:aws:secretsmanager:us-east-2:ACCOUNT:secret:bane/STAGE/mail-gateway/tls-key-??????","arn:aws:secretsmanager:us-east-2:ACCOUNT:secret:bane/STAGE/mail-gateway/api-token-??????"]}
]}
```

**2. Deploy policy: gateway resources and roles.** For create, refresh and updates; intentionally no teardown of protected resources, `RunTask`, image push, secret version management, `sns:Publish` or changes to the alerts topic. Name-scoped ECS permissions assume long service ARNs. The deployment waiter reads service deployments. `*` reads are APIs that lack resource-level authorization; restrict them to Ohio.

```json
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["ecr:CreateRepository","ecr:DescribeRepositories","ecr:PutImageScanningConfiguration","ecr:PutImageTagMutability","ecr:GetLifecyclePolicy","ecr:PutLifecyclePolicy","ecr:ListTagsForResource","ecr:TagResource","ecr:UntagResource"],"Resource":"arn:aws:ecr:us-east-2:ACCOUNT:repository/bane-mail-gateway"},
  {"Effect":"Allow","Action":["ecs:CreateCluster","ecs:DescribeClusters","ecs:UpdateCluster","ecs:CreateService","ecs:DescribeServices","ecs:UpdateService","ecs:ListServiceDeployments","ecs:DescribeServiceDeployments","ecs:RegisterTaskDefinition","ecs:ListTagsForResource","ecs:TagResource","ecs:UntagResource"],"Resource":["arn:aws:ecs:us-east-2:ACCOUNT:cluster/bane-mail-gateway","arn:aws:ecs:us-east-2:ACCOUNT:service/bane-mail-gateway/bane-mail-gateway","arn:aws:ecs:us-east-2:ACCOUNT:service-deployment/bane-mail-gateway/bane-mail-gateway/*","arn:aws:ecs:us-east-2:ACCOUNT:task-definition/bane-mail-gateway:*"]},
  {"Effect":"Allow","Action":["ecs:DescribeTaskDefinition","ecs:ListAccountSettings","logs:DescribeLogGroups"],"Resource":"*","Condition":{"StringEquals":{"aws:RequestedRegion":"us-east-2"}}},
  {"Effect":"Allow","Action":["logs:CreateLogGroup","logs:PutRetentionPolicy","logs:ListTagsForResource","logs:TagResource","logs:UntagResource"],"Resource":["arn:aws:logs:us-east-2:ACCOUNT:log-group:/ecs/bane-mail-gateway","arn:aws:logs:us-east-2:ACCOUNT:log-group:/ecs/bane-mail-gateway:*"]},
  {"Effect":"Allow","Action":["cloudwatch:PutMetricAlarm","cloudwatch:DescribeAlarms","cloudwatch:ListTagsForResource","cloudwatch:TagResource","cloudwatch:UntagResource"],"Resource":"arn:aws:cloudwatch:us-east-2:ACCOUNT:alarm:bane-mail-gateway-*"},
  {"Effect":"Allow","Action":["secretsmanager:CreateSecret","secretsmanager:DescribeSecret","secretsmanager:GetResourcePolicy","secretsmanager:TagResource","secretsmanager:UntagResource"],"Resource":"arn:aws:secretsmanager:us-east-2:ACCOUNT:secret:bane/STAGE/mail-gateway/*"},
  {"Effect":"Allow","Action":["iam:CreateRole","iam:GetRole","iam:ListRoleTags","iam:TagRole","iam:UntagRole","iam:ListRolePolicies","iam:GetRolePolicy","iam:ListAttachedRolePolicies"],"Resource":["arn:aws:iam::ACCOUNT:role/bane-mail-gateway-task","arn:aws:iam::ACCOUNT:role/bane-mail-gateway-execution"]},
  {"Effect":"Allow","Action":"iam:PutRolePolicy","Resource":"arn:aws:iam::ACCOUNT:role/bane-mail-gateway-execution"},
  {"Effect":"Allow","Action":"iam:PassRole","Resource":["arn:aws:iam::ACCOUNT:role/bane-mail-gateway-task","arn:aws:iam::ACCOUNT:role/bane-mail-gateway-execution"],"Condition":{"StringEquals":{"iam:PassedToService":"ecs-tasks.amazonaws.com"}}}
]}
```

**3. Deploy policy: gateway network.** ELB ARNs embed the gateway name. EC2 uses generated IDs, so create requires gateway tags and subsequent writes require the existing `bane:purpose` tag. Child creates also authorize the already-tagged parent VPC. The security-group-rule ARN permission is checked alongside the tagged SG when authorizing inline rules; it cannot authorize changes to another SG on its own.

```json
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["elasticloadbalancing:CreateLoadBalancer","elasticloadbalancing:ModifyLoadBalancerAttributes","elasticloadbalancing:SetSecurityGroups","elasticloadbalancing:SetSubnets","elasticloadbalancing:CreateListener","elasticloadbalancing:ModifyListener","elasticloadbalancing:ModifyListenerAttributes","elasticloadbalancing:CreateTargetGroup","elasticloadbalancing:ModifyTargetGroup","elasticloadbalancing:ModifyTargetGroupAttributes","elasticloadbalancing:AddTags","elasticloadbalancing:RemoveTags"],"Resource":["arn:aws:elasticloadbalancing:us-east-2:ACCOUNT:loadbalancer/net/bane-mail-gateway/*","arn:aws:elasticloadbalancing:us-east-2:ACCOUNT:listener/net/bane-mail-gateway/*/*","arn:aws:elasticloadbalancing:us-east-2:ACCOUNT:targetgroup/bane-mail-gateway-*/*"]},
  {"Effect":"Allow","Action":["elasticloadbalancing:DescribeLoadBalancers","elasticloadbalancing:DescribeLoadBalancerAttributes","elasticloadbalancing:DescribeCapacityReservation","elasticloadbalancing:DescribeListeners","elasticloadbalancing:DescribeListenerAttributes","elasticloadbalancing:DescribeTargetGroups","elasticloadbalancing:DescribeTargetGroupAttributes","elasticloadbalancing:DescribeTags","ec2:DescribeVpcs","ec2:DescribeSecurityGroups","ec2:DescribeSecurityGroupRules","ec2:DescribeSubnets","ec2:DescribeInternetGateways","ec2:DescribeRouteTables","ec2:DescribeNetworkAcls","ec2:DescribeNetworkInterfaces","ec2:DescribeTags"],"Resource":"*","Condition":{"StringEquals":{"aws:RequestedRegion":"us-east-2"}}},
  {"Effect":"Allow","Action":["ec2:CreateVpc","ec2:CreateSubnet","ec2:CreateRouteTable","ec2:CreateInternetGateway","ec2:CreateSecurityGroup"],"Resource":["arn:aws:ec2:us-east-2:ACCOUNT:vpc/*","arn:aws:ec2:us-east-2:ACCOUNT:subnet/*","arn:aws:ec2:us-east-2:ACCOUNT:route-table/*","arn:aws:ec2:us-east-2:ACCOUNT:internet-gateway/*","arn:aws:ec2:us-east-2:ACCOUNT:security-group/*"],"Condition":{"StringEquals":{"aws:RequestTag/bane:purpose":"mail-gateway"},"StringLike":{"aws:RequestTag/Name":"bane-mail-gateway-*"}}},
  {"Effect":"Allow","Action":["ec2:CreateSubnet","ec2:CreateRouteTable","ec2:CreateSecurityGroup"],"Resource":"arn:aws:ec2:us-east-2:ACCOUNT:vpc/*","Condition":{"StringEquals":{"ec2:ResourceTag/bane:purpose":"mail-gateway"}}},
  {"Effect":"Allow","Action":"ec2:CreateTags","Resource":"arn:aws:ec2:us-east-2:ACCOUNT:*","Condition":{"StringEquals":{"ec2:CreateAction":["CreateVpc","CreateSubnet","CreateRouteTable","CreateInternetGateway","CreateSecurityGroup"],"aws:RequestTag/bane:purpose":"mail-gateway"}}},
  {"Effect":"Allow","Action":["ec2:DescribeVpcAttribute","ec2:ModifyVpcAttribute","ec2:ModifySubnetAttribute","ec2:AttachInternetGateway","ec2:AssociateRouteTable","ec2:ReplaceRouteTableAssociation","ec2:CreateRoute","ec2:ReplaceRoute","ec2:DeleteRoute","ec2:AuthorizeSecurityGroupIngress","ec2:AuthorizeSecurityGroupEgress","ec2:RevokeSecurityGroupIngress","ec2:RevokeSecurityGroupEgress","ec2:CreateTags","ec2:DeleteTags"],"Resource":"arn:aws:ec2:us-east-2:ACCOUNT:*","Condition":{"StringEquals":{"ec2:ResourceTag/bane:purpose":"mail-gateway"}}},
  {"Effect":"Allow","Action":["ec2:AuthorizeSecurityGroupIngress","ec2:AuthorizeSecurityGroupEgress"],"Resource":"arn:aws:ec2:us-east-2:ACCOUNT:security-group-rule/*"}
]}
```

## Dax: one-time boundary change for the BYO broker

The deploy role creates the broker but can't edit the operator-owned `bane-runtime-boundary`. Its `AssumeBaneRoles` statement still names the earlier role patterns and not the broker, so until it changes, the runtime can't enter the broker. Nothing else depends on it: BYO isn't released and hosted sending never assumes a role. After the stage's Pulumi run has created `nightmail-byo-broker`, replace **only that statement**; every other statement stays as it is:

```sh
account=905840579680 profile=bane-dev   # production: 009882681002 and its profile
arn=arn:aws:iam::$account:policy/bane-runtime-boundary
v=$(aws iam get-policy --profile "$profile" --policy-arn "$arn" --query Policy.DefaultVersionId --output text)
aws iam get-policy-version --profile "$profile" --policy-arn "$arn" --version-id "$v" --query PolicyVersion.Document > live.json
jq --arg role "arn:aws:iam::$account:role/nightmail-byo-broker" '.Statement |= map(if .Sid == "AssumeBaneRoles"
  then {Sid:"ByoBroker",Effect:"Allow",Action:"sts:AssumeRole",Resource:$role,Condition:{StringEquals:{"sts:RoleSessionName":"nightmail-broker"}}} else . end)' live.json > next.json
diff <(jq -S . live.json) <(jq -S . next.json)   # expect exactly that one statement to change
aws iam create-policy-version --profile "$profile" --policy-arn "$arn" --policy-document file://next.json --set-as-default
```

IAM keeps at most five versions of a policy; if the boundary already has five, delete its oldest non-default version first. [runtime-boundary-policy.json](../aws-shared/runtime-boundary-policy.json) carries the same `ByoBroker` statement for reference.

## Bring your own AWS: template bucket and setup topic

[byo-setup.ts](byo-setup.ts) creates, with `bane:byoSetup: "true"` in the stage's settings:

- **`nightmail-byo-templates-<account>`** (Ohio, protected, versioned): customers' CloudFormation reads the role templates from `byo/<version>.yaml`, one object per [api/byo-templates/](../../api/byo-templates/) file. Only `byo/*` is publicly readable; the bucket blocks ACLs. Published objects are never changed (`check-premerge.ts`) and survive their removal from the program.
- **`nightmail-byo-setup`** (Ohio, protected): customers' stacks publish their Create, Update and Delete requests here (any account may publish), and an HTTPS subscription delivers them to the stage's events host (`/v1/events/cloudformation`), which verifies each signature and proves the customer's role before answering.

Customer stacks name both forever (the template's `ServiceToken` and its update permission), so never rename or delete them.

### Dax: one-time IAM for BYO setup

The deploy role's S3 and SNS permissions name their resources, so it can't create these until it has [byo-setup-deploy-policy.json](../aws-shared/byo-setup-deploy-policy.json), with `YOUR_AWS_ACCOUNT_ID` and `YOUR_EVENTS_ORIGIN` substituted (dev: `905840579680`, `https://events.dev.nightmail.dev`; production: `009882681002`, `https://events.nightmail.dev`), as an inline policy on the stage's deploy role. It has no delete permissions. Then set `bane:byoSetup: "true"` in that stage's settings.

## Tenant status events

EventBridge rules, targets (including their entire input), delivery roles and their grants are operator-owned. CI verifies the exact rule patterns and unchanged SNS envelopes; it cannot rewrite them. Signed SNS notifications are hints only: Nightmail checks workspace/topic ownership and reads `GetReputationEntity` for the exact tenant and origin before recording a transition. Stale notifications do nothing, lookup failures retry, and enables never resume a workspace.

Before rollout, allow `ses:GetReputationEntity` alongside the existing status-update permission on the same tenant ARNs in the runtime boundary and identity policies. Provision/verify both regional routes (Virginia after signed enrollment). Do not enqueue until these prerequisites are verified. `python3 infra/pulumi/tenant-status/plan.py --plan --stage dev` (or `production`) simulates the proposed grants without writing AWS state.
