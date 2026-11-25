#!/usr/bin/env bash
# Classify the merge checkout, not just the last commit in a PR or a queue batch.
set -euo pipefail
all=false
case "$GITHUB_EVENT_NAME" in
  pull_request) base=$(git rev-parse HEAD^1) ;;
  merge_group)
    tip=$(git ls-remote --exit-code origin refs/heads/dev | cut -f1)
    [[ $tip =~ ^[0-9a-f]{40}$ ]]
    # HEAD^1 may be another unmerged PR. If dev advanced beyond this group
    # (e.g. a rerun), don't use an empty or unrelated diff to waive checks.
    if git rev-list --first-parent HEAD^1 | grep -Fx "$tip" >/dev/null; then
      base=$tip
    else
      base=$EVENT_BASE
      all=true
    fi ;;
  push) base=$EVENT_BASE; all=true ;;
  *) echo "::error::Unknown CI event: $GITHUB_EVENT_NAME"; exit 1 ;;
esac
[[ $base =~ ^[0-9a-f]{40}$ ]]
paths=$(mktemp)
trap 'rm -f "$paths"' EXIT
# Don't lose the old path on renames, split on whitespace, or turn a diff error into 'nothing changed'.
git diff --name-only --no-renames -z "$base" HEAD > "$paths"
# A queue entry can undo an earlier entry's contract change, leaving no net spec diff from dev.
if [[ $GITHUB_EVENT_NAME == merge_group ]]; then
  git diff --name-only --no-renames -z HEAD^1 HEAD -- api/openapi.json >> "$paths"
fi
# Advisories are published against unchanged lockfiles, so the audit runs on every PR, queue entry and direct push.
api=false sdk=false dashboard=false acceptance=false gateway=false support=false audit=true
while IFS= read -r -d '' path; do
  case "$path" in
    .github/workflows/*|.github/actions/*|.github/scripts/*|*/bun.lock|*/bun.lockb|*/Cargo.lock|*/package-lock.json|*/pnpm-lock.yaml|*/yarn.lock) all=true ;;
    # These Markdown files are runtime inputs or executable examples/assertions.
    app/src/features/legal/content/*.md) dashboard=true ;;
    support/VOICE.md|support/src/*.md) support=true ;;
    api/README.md|docs/mcp-coverage.md) acceptance=true ;;
    *.md) continue ;;
    api/*) api=true; acceptance=true ;;
    app/*) dashboard=true ;;
    sdk/*|mcp/*) sdk=true; acceptance=true ;;
    support/*) support=true ;;
    gateway/*) gateway=true ;;
    domain-connect/*|infra/aws-shared/*|infra/pulumi/receiving-alarm.ts|.github/s3-fixture/*) acceptance=true ;;
  esac
  case "$path" in
    # The dashboard imports these API modules directly and renders /openapi.json. It does not import sdk/src.
    api/openapi.json|api/src/analytics-events.ts|api/src/billing/rates.ts|api/src/block-style.ts|api/src/brand.ts|api/src/mcp-clients.ts|api/src/ritual-schema.ts|api/src/standing-model.ts|api/src/webhook-signature-guide.ts) dashboard=true ;;
  esac
  case "$path" in
    api/src/brand.ts|api/src/log.ts|api/src/billing/rates.ts|api/src/mail-servers.ts|api/wrangler.prod.jsonc) support=true ;;
  esac
  case "$path" in
    # Dashboard modules and assets exercised directly by api.acceptance.test.ts.
    app/asset-headers.ts|app/public/_headers|app/public/theme.js|app/public/signed-in/*|app/src/lib/*|app/src/data/types.ts|app/src/features/settings/*) acceptance=true ;;
  esac
done < "$paths"
if $all; then api=true; sdk=true; dashboard=true; acceptance=true; gateway=true; support=true; audit=true; fi
build=false preview=false cls=false
if $api || $dashboard || $sdk; then build=true; fi
if $api || $dashboard; then preview=true; fi
# The CLS fixture runs this API (migrations, server, read limits) and seeds its tables with raw SQL.
if $api || $dashboard; then cls=true; fi
for key in base api sdk dashboard build acceptance preview cls gateway support audit; do
  printf '%s=%s\n' "$key" "${!key}"
done | tee -a "$GITHUB_OUTPUT"
