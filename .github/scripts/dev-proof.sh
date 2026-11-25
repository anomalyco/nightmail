#!/usr/bin/env bash
# Usage: dev-proof.sh <sha>. Require live dev E2E and queue CI (or a full direct dev push CI) for this exact SHA.
set -euo pipefail
sha=$1 repo="repos/$GITHUB_REPOSITORY" wait=${CI_WAIT_SECONDS:-1500} poll=${CI_POLL_SECONDS:-30}
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "usage: $0 <sha>" >&2; exit 2; }

# The dev deploy job's name comes from the same pinned output as its checkout, so its E2E step proves this commit.
# Only that job and its E2E count, not the run's conclusion: a later job in the run (the support Worker's deploy) can
# fail without saying anything about Nightmail, and must not hold back a Nightmail release.
e2e=
for ((page=1; ; page++)); do
  # Support may still be running. Only the completed main Worker job is proof.
  runs=$(gh api "$repo/actions/workflows/deploy.yml/runs?branch=dev&head_sha=$sha&per_page=100&page=$page")
  [[ $(jq '.workflow_runs | length' <<< "$runs") != 0 ]] || break
  ids=$(jq -r --arg sha "$sha" --arg repo "$GITHUB_REPOSITORY" '.workflow_runs[] | select(.head_sha == $sha and .head_branch == "dev" and .head_repository.full_name == $repo and (.event == "push" or .event == "workflow_dispatch")) | .id' <<< "$runs")
  for id in $ids; do
    if gh api "$repo/actions/runs/$id/jobs?filter=latest&per_page=100" |
      jq -e --arg job "Deploy dev $sha" 'any(.jobs[]; .name == $job and .conclusion == "success" and any(.steps[]; .name == "Live dev E2E" and .conclusion == "success"))' >/dev/null; then
      e2e=$id; break 2
    fi
  done
done
[[ -n $e2e ]] || { echo "::error::No successful deploy.yml dev job with a passing live E2E for exactly $sha"; exit 1; }
echo "Live dev E2E passed for $sha in run $e2e."

deadline=$((SECONDS + wait))
while :; do
  # A queue push produces an all-skipped green CI run. Only the queue's own CI on the
  # dev queue ref (or the full CI of a direct dev push) can prove this SHA.
  proof=$(gh api "$repo/actions/workflows/ci.yml/runs?head_sha=$sha&per_page=100" |
    jq -c --arg sha "$sha" --arg repo "$GITHUB_REPOSITORY" '[.workflow_runs[] |
      select(.head_sha == $sha and .head_repository.full_name == $repo) |
      select((.event == "merge_group" and (.head_branch | startswith("gh-readonly-queue/dev/"))) or
             (.event == "push" and .head_branch == "dev" and .actor.login != null and .actor.login != "github-merge-queue[bot]"))] |
      max_by(.id) | {id, event, status, conclusion}')
  if [[ $(jq -r '.conclusion' <<< "$proof") == success ]]; then
    echo "CI passed for $sha: $(jq -r '.event + " run " + (.id|tostring)' <<< "$proof")."; exit 0
  fi
  if [[ $(jq -r '.status' <<< "$proof") == completed || $(jq -r '.id' <<< "$proof") == null ]]; then
    echo "::error::No passing dev merge-group or direct dev push CI for $sha."
    exit 1
  fi
  if (( SECONDS >= deadline )); then echo "::error::CI for $sha was still running after $((wait / 60)) minutes."; exit 1; fi
  echo "CI for $sha is still running; checking again in ${poll}s."
  sleep "$poll"
done
