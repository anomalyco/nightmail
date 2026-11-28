#!/usr/bin/env bash
# Usage: pulumi-has-work.sh <stage> <sha>. Writes pulumi=true|false to $GITHUB_OUTPUT (stdout when unset) and the
# reason to the step summary (stderr when unset). Runs from a full-history checkout of the stage branch.
#
# The base is the head SHA of this stage's newest healthy main Worker deployment. Deploy runs only after Pulumi succeeded or
# was skipped because nothing it reads had changed since such a commit, so the stack matches the base. Not the
# previous tip or first parent (N12): a superseded run stops at its tip check and never counts, so the next run still
# sees the infrastructure change it carried.
set -euo pipefail
stage=$1 sha=$2
out=${GITHUB_OUTPUT:-/dev/stdout} summary=${GITHUB_STEP_SUMMARY:-/dev/stderr}
decide() { echo "pulumi=$1" >> "$out"; echo "tenant_status=${tenant_status:-true}" >> "$out"; echo "$2" >> "$summary"; exit 0; }
[[ $stage =~ ^(dev|production)$ && $sha =~ ^[0-9a-f]{40}$ ]] || { echo "usage: $0 <dev|production> <sha>" >&2; exit 2; }

base=${DEPLOYED_BASE:-$(bash .github/scripts/deployed-sha.sh "$stage")}
if [[ -z $base ]] || ! git cat-file -e "$base^{commit}" 2>/dev/null || ! git merge-base --is-ancestor "$base" "$sha"; then
  decide true "No deployed $stage commit is an ancestor of $sha; running Pulumi."
fi

changed=$(git diff --name-only "$base" "$sha")
tenant_status=false
if grep -Eq "^(infra/pulumi/(tenant-status/|Pulumi\.$stage\.yaml$|package\.json$|bun\.lock$)|\.github/scripts/(tenant-status-verify|pulumi-has-work)\.sh$)" <<< "$changed"; then
  tenant_status=true
fi
# What the Pulumi program reads: infra/pulumi and infra/aws-shared (not their docs), the shared mail-control
# documents, the published BYO role templates, and the receiving-set check its job runs.
# A stack settings file is only read by the selected stack. Shared changes since
# the actual deployed base still count, not merely changes introduced by the PR.
other=dev; [[ $stage == dev ]] && other=production
inputs=$(grep -E '^(infra/|api/src/mail-controls\.ts$|api/byo-templates/|\.github/scripts/receiving-rule-set\.sh$|\.github/actions/cloudflare-token/)' <<< "$changed" | grep -v '\.md$' | grep -Fxv "infra/pulumi/Pulumi.$other.yaml" || true)

# The Pulumi job itself, aliases expanded and Require guards removed: a guard only stops a run, never changes what
# Pulumi applies. A change anywhere else in deploy.yml (the Worker deploy, the E2E) is not Pulumi's.
if grep -qx '.github/workflows/deploy.yml' <<< "$changed"; then
  # Compare resolved job definitions. Only the known runner labels and the exact download-cache step are
  # immaterial; a different program, cache source/path, plugin version, command, or unknown runner still applies.
  job() {
    git show "$1:.github/workflows/deploy.yml" | yq -o=json 'explode(.) | .jobs.pulumi | del(.steps[] | select((.name // "") | test("^Require ")))' - |
      jq -ecS 'select(type=="object" and (.steps|length)>0)
        | if (.["runs-on"]|IN("ubuntu-latest","blacksmith-4vcpu-ubuntu-2404")) then del(.["runs-on"]) else . end
        | .steps |= map(select((.uses == "actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830" and
          .with.path == "~/.pulumi/plugins\n~/.bun/install/cache\n" and (.with|keys) == ["key","path"]) | not))'
  }
  if ! before=$(job "$base") || ! after=$(job "$sha") || [[ $before != "$after" ]]; then
    tenant_status=true
    decide true "The Pulumi job in deploy.yml changed since $base."
  fi
fi
[[ -z $inputs ]] || decide true "Pulumi inputs changed since $base."
# A verifier or scope-script edit still requires the live tenant check; it does not change the desired stack.
# deploy.yml runs that verification before migration when there is no Pulumi job to run it.
decide false "No Pulumi input changed since the deployed commit $base; skipping Pulumi."
