#!/usr/bin/env bash
set -euo pipefail
# Plain GitHub variables are non-confidential. An empty variable means do not
# override a same-named Worker secret (or: no allowed values if none exists).
# Never print argv or Wrangler's informational bindings table.
config=$1
wrangler=./node_modules/.bin/wrangler
args=(deploy --config "$config")
# The Secrets Manager action masks these stage-specific values. Keep them out
# of argv and sync them in the same Worker version as the application code.
set +x
umask 077
tmp=$(mktemp -d "${RUNNER_TEMP:?}/nightmail-rollout.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
secrets_file="$tmp/desired.json"
obsolete=()
# Hosted sign-in and MCP accept only the account service's own sign-in methods: config.ts refuses to start
# without them, so fail here, before secrets sync or migrations, instead of deploying a 503.
acr=$(node -e "const ts=require('typescript');const c=ts.parseConfigFileTextToJson('w',require('fs').readFileSync(process.argv[1],'utf8')).config;process.stdout.write(String(c?.vars?.MULTI_TENANT)+' '+String(c?.vars?.ACCOUNT_REQUIRED_ACR))" "$config")
[[ $acr =~ ^true\ urn:anomaly:acr:(github|google|email|password)(\ urn:anomaly:acr:(github|google|email|password))*$ ]] || { echo "::error::$config must set MULTI_TENANT=true and ACCOUNT_REQUIRED_ACR to the account service's methods (urn:anomaly:acr:github, google, email, password)"; exit 1; }
# Link hosts (api/src/link-domains.ts): the custom hostnames token, nightmail/<stage>/NIGHTMAIL_LINK_SAAS_TOKEN, follows the
# committed NIGHTMAIL_LINK_SAAS_ZONE_ID; older serving versions require both or neither. With the zone set, the token is required: missing, unreadable or malformed stops the deploy
# here, before anything changes; it is bound with the app secrets below. Without the zone, a token left on the Worker is
# deleted below. The value never reaches argv or the log.
link_zone=$(node -e "const ts=require('typescript');const c=ts.parseConfigFileTextToJson('w',require('fs').readFileSync(process.argv[1],'utf8')).config;process.stdout.write(String(c?.vars?.NIGHTMAIL_LINK_SAAS_ZONE_ID??''))" "$config")
unset link_token
if [[ -n $link_zone ]]; then
  [[ $link_zone =~ ^[0-9a-f]{32}$ ]] || { echo "::error::NIGHTMAIL_LINK_SAAS_ZONE_ID in $config must be a Cloudflare zone id"; exit 1; }
  link_token=$(aws secretsmanager get-secret-value --secret-id "nightmail/${STAGE:-}/NIGHTMAIL_LINK_SAAS_TOKEN" --query SecretString --output text) ||
    { echo "::error::$config sets NIGHTMAIL_LINK_SAAS_ZONE_ID, but nightmail/${STAGE:-}/NIGHTMAIL_LINK_SAAS_TOKEN could not be read"; exit 1; }
  # Check before masking: a workflow command masks one line and unescapes %XX.
  [[ $link_token =~ ^[A-Za-z0-9._~+/=-]{20,}$ && ${#link_token} -le 500 ]] ||
    { unset link_token; echo "::error::nightmail/${STAGE:-}/NIGHTMAIL_LINK_SAAS_TOKEN must be one line of 20 to 500 characters from [A-Za-z0-9._~+/=-]"; exit 1; }
  echo "::add-mask::$link_token"
fi
for name in BANE_ROOT_SECRET ACCOUNT_CLIENT_PRIVATE_KEY TYPESAFE_API_KEY; do
  [[ -n ${!name:-} ]] || { echo "::error::Missing required app secret: $name"; exit 1; }
done
# shellcheck disable=SC2016 # A jq program: $ENV is jq's, not the shell's.
app_secrets='$ENV | {BANE_ROOT_SECRET, ACCOUNT_CLIENT_PRIVATE_KEY, TYPESAFE_API_KEY}'

# The IMAP/SMTP gateway's shared key (gateway/PHASE2.md). The stage's committed
# bane:mailGatewayEnabled is the only switch, so neither state can fail open:
# enabled requires nightmail/<stage>/MAILGW_API_TOKEN, and disabled removes the Worker's
# binding, which a deploy would otherwise inherit. The key is fetched here, the
# only step that needs it, and leaves this process only through the secrets file.
unset MAILGW_API_TOKEN
case ${STAGE:-} in dev|production) ;; *) echo "::error::STAGE must be dev or production"; exit 1 ;; esac
stack="$(dirname "$0")/../../infra/pulumi/Pulumi.$STAGE.yaml"
[[ -f $stack ]] || { echo "::error::Missing $stack"; exit 1; }
flags=$(grep -cE '^[[:space:]]*bane:mailGatewayEnabled[[:space:]]*:' "$stack" || true)
flag_re='^  bane:mailGatewayEnabled: ("?)(true|false)("?)[[:space:]]*$'
case $flags in
  0) gateway=false ;;
  1) line=$(grep -E '^[[:space:]]*bane:mailGatewayEnabled[[:space:]]*:' "$stack")
     if [[ $line =~ $flag_re && ${BASH_REMATCH[1]} == "${BASH_REMATCH[3]}" ]]; then gateway=${BASH_REMATCH[2]}
     else echo "::error::bane:mailGatewayEnabled in Pulumi.$STAGE.yaml must be true or false"; exit 1; fi ;;
  *) echo "::error::bane:mailGatewayEnabled is set more than once in Pulumi.$STAGE.yaml"; exit 1 ;;
esac
list_bindings() {
  "$wrangler" secret list --config "$config" | jq -ce 'select(type=="array" and all(.[]; (.name|type)=="string")) | map(.name)'
}
if [[ $gateway == true ]]; then
  # Missing, pending deletion, unreadable and malformed all stop here.
  token=$(aws secretsmanager get-secret-value --secret-id "nightmail/$STAGE/MAILGW_API_TOKEN" --query SecretString --output text) ||
    { echo "::error::bane:mailGatewayEnabled is true, but nightmail/$STAGE/MAILGW_API_TOKEN could not be read"; exit 1; }
  # Check before masking: a workflow command masks one line and unescapes %XX.
  if [[ ! $token =~ ^[A-Za-z0-9._~+/=-]{32,}$ ]]; then
    echo "::error::nightmail/$STAGE/MAILGW_API_TOKEN must be at least 32 characters from [A-Za-z0-9._~+/=-]"; exit 1
  fi
  echo "::add-mask::$token"
  MAILGW_API_TOKEN=$token jq -n "$app_secrets + {MAILGW_API_TOKEN}" > "$secrets_file"
  unset token
else
  jq -n "$app_secrets" > "$secrets_file"
  obsolete+=(MAILGW_API_TOKEN)
fi
# Hosted billing's Stripe keys (api/README.md, Stripe setup), from nightmail/<stage>/STRIPE_*. The Worker takes payments
# only with both. A key for the other Stripe mode always stops here: dev takes test keys, production live ones.
# Without usable keys the deploy continues while the stage's billing is off or in shadow (payments answer
# 503 BILLING_NOT_CONFIGURED), and stops when billing_config.mode is enforce. Values never reach argv or the log.
stripe_mode='test'; [[ $STAGE == production ]] && stripe_mode='live'
if [[ ${STRIPE_SECRET_KEY:-} =~ ^(sk|rk)_(test|live)_ && ${BASH_REMATCH[2]} != "$stripe_mode" ]]; then
  echo "::error::nightmail/$STAGE/STRIPE_SECRET_KEY is a ${BASH_REMATCH[2]}-mode key, but $STAGE takes $stripe_mode-mode keys"; exit 1
fi
if [[ ${STRIPE_SECRET_KEY:-} =~ ^(sk|rk)_${stripe_mode}_[A-Za-z0-9_]+$ && ${STRIPE_WEBHOOK_SECRET:-} =~ ^whsec_[A-Za-z0-9_]+$ ]]; then
  # shellcheck disable=SC2016 # A jq program: $ENV is jq's, not the shell's.
  with_stripe=$(jq '. + ($ENV | {STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET})' "$secrets_file") && printf '%s\n' "$with_stripe" > "$secrets_file"
  unset with_stripe
  echo "Billing: binding the $stripe_mode-mode Stripe keys."
else
  # The migrations above just ran against this database. Without billing_config yet, billing is off.
  billing=$(node --import tsx -e "const {Client}=require('pg');import('./src/adapters/node.ts').then(async ({postgresConnection})=>{const c=new Client(postgresConnection(process.env.DATABASE_URL));await c.connect();try{const r=await c.query(\"SELECT CASE WHEN to_regclass('billing_config') IS NULL THEN 'off' ELSE (SELECT mode FROM billing_config WHERE singleton) END AS mode\");process.stdout.write(r.rows[0]?.mode??'off')}finally{await c.end()}})") ||
    { echo "::error::Could not read billing_config.mode for $STAGE"; exit 1; }
  if [[ $billing == enforce ]]; then
    echo "::error::Billing is enforced on $STAGE, but nightmail/$STAGE/STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are not both $stripe_mode-mode Stripe values. Set them, or switch billing back to shadow (scripts/set-billing-enforcement.ts) first."; exit 1
  fi
  obsolete+=(STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET)
  echo "::warning::Billing is ${billing:-off} on $STAGE and its Stripe keys are not set: payments answer 503 BILLING_NOT_CONFIGURED."
fi
# The operator alerts' Slack webhook (api/src/operator-alerts.ts), optional: nightmail/<stage>/OPERATOR_SLACK_WEBHOOK_URL.
# Set and a Slack incoming webhook URL, it is bound with the app secrets. Not set (or scheduled for deletion), the Worker
# keeps none: a deploy inherits a Worker secret its file leaves out, so one left from before is deleted here, and
# taking the secret out of Secrets Manager turns the cards off at the next deploy. Malformed, the cards stay off. Any
# other read failure leaves the Worker as it is. None of these fails the deploy; the value never reaches argv or the log.
hook_err="$tmp/hook.err"
operator_hook=off
if hook=$(aws secretsmanager get-secret-value --secret-id "nightmail/$STAGE/OPERATOR_SLACK_WEBHOOK_URL" --query SecretString --output text 2>"$hook_err"); then
  # Check before masking: a workflow command masks one line and unescapes %XX.
  if [[ $hook =~ ^https://hooks\.slack\.com/[A-Za-z0-9/_-]+$ ]]; then
    echo "::add-mask::$hook"
    # shellcheck disable=SC2016 # A jq program: $ENV is jq's, not the shell's.
    with_hook=$(OPERATOR_SLACK_WEBHOOK_URL=$hook jq '. + ($ENV | {OPERATOR_SLACK_WEBHOOK_URL})' "$secrets_file") && printf '%s\n' "$with_hook" > "$secrets_file"
    unset with_hook
    operator_hook=bound
  else
    echo "::warning::nightmail/$STAGE/OPERATOR_SLACK_WEBHOOK_URL is not a Slack incoming webhook URL (https://hooks.slack.com/...): operator alerts are off."
  fi
elif grep -qE 'ResourceNotFoundException|marked for deletion' "$hook_err"; then
  operator_hook='not set'
else
  operator_hook=unknown
  echo "::warning::nightmail/$STAGE/OPERATOR_SLACK_WEBHOOK_URL could not be read; the Worker's operator alerts are left as they were."
fi
unset hook
if [[ $operator_hook == off || $operator_hook == 'not set' ]]; then obsolete+=(OPERATOR_SLACK_WEBHOOK_URL); fi
echo "Operator alerts: nightmail/$STAGE/OPERATOR_SLACK_WEBHOOK_URL is $operator_hook."
# The second classifier's key (api/src/screen-shadow.ts), optional: nightmail/<stage>/JEVF_API_KEY. As the operator
# alerts' webhook above. Set and one line of printable characters, it is bound with the app secrets and the second
# classifier runs in the content screen's shadow. Not set (or scheduled for deletion), the Worker keeps none: one left
# from before is deleted here, and taking the secret out of Secrets Manager turns it off at the next deploy. Malformed,
# it stays off. Any other read failure leaves the Worker as it is. None of these fails the deploy; the value never
# reaches argv or the log.
jevf_err="$tmp/jevf.err"
jevf_key=off
if key=$(aws secretsmanager get-secret-value --secret-id "nightmail/$STAGE/JEVF_API_KEY" --query SecretString --output text 2>"$jevf_err"); then
  # Check before masking: a workflow command masks one line and unescapes %XX.
  if [[ $key =~ ^[A-Za-z0-9._~+/=:@-]{8,}$ && ${#key} -le 512 ]]; then
    echo "::add-mask::$key"
    # shellcheck disable=SC2016 # A jq program: $ENV is jq's, not the shell's.
    with_key=$(JEVF_API_KEY=$key jq '. + ($ENV | {JEVF_API_KEY})' "$secrets_file") && printf '%s\n' "$with_key" > "$secrets_file"
    unset with_key
    jevf_key=bound
  else
    echo "::warning::nightmail/$STAGE/JEVF_API_KEY is not one line of 8 to 512 characters from [A-Za-z0-9._~+/=:@-]: the second classifier is off."
  fi
elif grep -qE 'ResourceNotFoundException|marked for deletion' "$jevf_err"; then
  jevf_key='not set'
else
  jevf_key=unknown
  echo "::warning::nightmail/$STAGE/JEVF_API_KEY could not be read; the Worker's second classifier is left as it was."
fi
unset key
if [[ $jevf_key == off || $jevf_key == 'not set' ]]; then obsolete+=(JEVF_API_KEY); fi
echo "Second classifier: nightmail/$STAGE/JEVF_API_KEY is $jevf_key."
# Glass's Gmail Postmaster Tools grant (api/src/glass-deliverability.ts), optional: nightmail/<stage>/NIGHTMAIL_POSTMASTER_CREDENTIALS,
# the JSON api/scripts/postmaster-auth.ts writes. As the second classifier's key above. Set and a grant (clientId,
# clientSecret and refreshToken, at most 4000 characters), it is bound with the app secrets as one line and Glass reads
# Postmaster Tools. Not set (or scheduled for deletion), the Worker keeps none: one left from before is deleted here, and
# taking the secret out of Secrets Manager stops the reads at the next deploy. Malformed, the reads stay off. Any other
# read failure leaves the Worker as it is. None of these fails the deploy; the value never reaches argv or the log.
postmaster_err="$tmp/postmaster.err"
postmaster=off
if grant=$(aws secretsmanager get-secret-value --secret-id "nightmail/$STAGE/NIGHTMAIL_POSTMASTER_CREDENTIALS" --query SecretString --output text 2>"$postmaster_err"); then
  if grant=$(jq -ce 'select(type=="object" and ([.clientId, .clientSecret, .refreshToken] | all(type=="string" and length>0)))' <<<"$grant" 2>/dev/null) && (( ${#grant} <= 4000 )); then
    # One line after jq -c; the secret parts are masked on their own too, in case a tool prints them alone.
    echo "::add-mask::$grant"
    echo "::add-mask::$(jq -r .clientSecret <<<"$grant")"
    echo "::add-mask::$(jq -r .refreshToken <<<"$grant")"
    # shellcheck disable=SC2016 # A jq program: $ENV is jq's, not the shell's.
    with_grant=$(NIGHTMAIL_POSTMASTER_CREDENTIALS=$grant jq '. + ($ENV | {NIGHTMAIL_POSTMASTER_CREDENTIALS})' "$secrets_file") && printf '%s\n' "$with_grant" > "$secrets_file"
    unset with_grant
    postmaster=bound
  else
    echo "::warning::nightmail/$STAGE/NIGHTMAIL_POSTMASTER_CREDENTIALS is not a Postmaster grant (JSON with clientId, clientSecret and refreshToken, at most 4000 characters): Glass's Postmaster reads are off."
  fi
elif grep -qE 'ResourceNotFoundException|marked for deletion' "$postmaster_err"; then
  postmaster='not set'
else
  postmaster=unknown
  echo "::warning::nightmail/$STAGE/NIGHTMAIL_POSTMASTER_CREDENTIALS could not be read; the Worker's Postmaster grant is left as it was."
fi
unset grant
if [[ $postmaster == off || $postmaster == 'not set' ]]; then obsolete+=(NIGHTMAIL_POSTMASTER_CREDENTIALS); fi
echo "Gmail Postmaster: nightmail/$STAGE/NIGHTMAIL_POSTMASTER_CREDENTIALS is $postmaster."
# Private lines (api/src/list-risk-lines.ts, api/src/ramp-lines.ts), optional: nightmail/<stage>/NIGHTMAIL_LIST_RISK and
# nightmail/<stage>/NIGHTMAIL_RAMP, each a JSON object: the list-risk measure's band lines, and the send review's ramp
# sizing and a campaign's send guards. As the Postmaster grant above: set and a JSON object of at most 4000 characters,
# bound with the app secrets as one line; not set (or scheduled for deletion), the Worker keeps none and the code's
# defaults apply (one left from before is deleted here); malformed, the binding is removed. Any other read failure
# leaves the Worker as it is. None of these fails the deploy. Not credentials, but kept out of the repository and the log.
for name in NIGHTMAIL_LIST_RISK NIGHTMAIL_RAMP; do
  lines_err="$tmp/$name.err"
  lines_state=off
  if value=$(aws secretsmanager get-secret-value --secret-id "nightmail/$STAGE/$name" --query SecretString --output text 2>"$lines_err"); then
    if value=$(jq -ce 'select(type=="object")' <<<"$value" 2>/dev/null) && (( ${#value} <= 4000 )); then
      echo "::add-mask::$value"
      # shellcheck disable=SC2016 # A jq program: $ENV is jq's, not the shell's.
      with_value=$(LINES_NAME=$name LINES_VALUE=$value jq '. + {($ENV.LINES_NAME): $ENV.LINES_VALUE}' "$secrets_file") && printf '%s\n' "$with_value" > "$secrets_file"
      unset with_value
      lines_state=bound
    else
      echo "::warning::nightmail/$STAGE/$name is not a JSON object of at most 4000 characters: its defaults apply."
    fi
  elif grep -qE 'ResourceNotFoundException|marked for deletion' "$lines_err"; then
    lines_state='not set'
  else
    lines_state=unknown
    echo "::warning::nightmail/$STAGE/$name could not be read; the Worker's value is left as it was."
  fi
  unset value
  if [[ $lines_state == off || $lines_state == 'not set' ]]; then obsolete+=("$name"); fi
  echo "Private lines: nightmail/$STAGE/$name is $lines_state."
done
if [[ -n ${link_token:-} ]]; then
  # shellcheck disable=SC2016 # A jq program: $ENV is jq's, not the shell's.
  with_link=$(NIGHTMAIL_LINK_SAAS_TOKEN=$link_token jq '. + ($ENV | {NIGHTMAIL_LINK_SAAS_TOKEN})' "$secrets_file") && printf '%s\n' "$with_link" > "$secrets_file"
  unset with_link link_token
  echo "Link hosts: zone $link_zone; binding nightmail/$STAGE/NIGHTMAIL_LINK_SAAS_TOKEN."
else
  obsolete+=(NIGHTMAIL_LINK_SAAS_TOKEN)
fi
# Omitted secrets are inherited. Blank an obsolete binding in the incoming version only, so
# it cannot authenticate or enable a feature during cleanup; the serving version still has its value.
existing=$(list_bindings)
printf '%s\n' "${obsolete[@]}" | jq -Rn --argjson existing "$existing" \
  '[inputs | select(. as $key | $existing | index($key))] | map({key:.,value:null}) | from_entries' >"$tmp/remove.json"
jq -s '.[0] + (.[1] | with_entries(.value=""))' "$secrets_file" "$tmp/remove.json" >"$tmp/upload.json"
secrets_file="$tmp/upload.json"
args+=(--secrets-file "$secrets_file")
# Every log line names the commit it runs (core.ts setLogContext), for the nightly report's 5xx-by-deploy table; Glass
# shows the commit and when it went out.
if [[ ${DEPLOY_SHA:-} =~ ^[0-9a-f]{40}$ ]]; then args+=(--var "DEPLOY_SHA:$DEPLOY_SHA" --var "DEPLOY_AT:$(date -u +%Y-%m-%dT%H:%M:%SZ)"); fi
# shellcheck source=/dev/null
source "$(dirname "$0")/cloudflare-retry.sh"
WRANGLER_OUTPUT_FILE_PATH="$tmp/receipt.jsonl" WRANGLER_LOG=error cloudflare_retry "$wrangler" "${args[@]}"
# A successful upload alone is not proof of cutover. Compare Wrangler's receipt with the actual
# deployment allocation. A stale, split or unreadable allocation must leave live secrets alone.
version=$(jq -ers '[.[] | select(.type=="deploy")] | last.version_id | select(type=="string" and length>0)' "$tmp/receipt.jsonl")
"$wrangler" deployments status --json --config "$config" | jq -e --arg id "$version" \
  '(.versions|length)==1 and .versions[0].version_id==$id and .versions[0].percentage==100' >/dev/null ||
  { echo "::error::The uploaded Worker version is not verified at 100% traffic; no obsolete secrets removed"; exit 1; }
if jq -e 'length>0' "$tmp/remove.json" >/dev/null; then
  # Wrangler 4.130 interprets JSON null as a deletion in secret bulk (one merge patch).
  WRANGLER_LOG=error "$wrangler" secret bulk "$tmp/remove.json" --config "$config" >/dev/null
fi
actual=$(list_bindings)
jq -en --argjson actual "$actual" --slurpfile removed "$tmp/remove.json" \
  'all($removed[0]|keys[]; . as $key | $actual | index($key) == null)' >/dev/null ||
  { echo "::error::An obsolete binding remains on the new Worker"; exit 1; }
state=$(jq -r 'index("MAILGW_API_TOKEN") != null' <<< "$actual")
[[ $state == "$gateway" ]] || { echo "::error::Worker MAILGW_API_TOKEN bound=$state, but bane:mailGatewayEnabled=$gateway"; exit 1; }
echo "Mail gateway: bane:mailGatewayEnabled=$gateway; Worker MAILGW_API_TOKEN bound=$state."
