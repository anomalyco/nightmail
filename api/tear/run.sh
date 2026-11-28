#!/usr/bin/env bash
# On-demand runner for Nightmail's reworked TypeScript tear models.
#
# Usage (from api/ or via `bun run tear:ci`):
#   bash tear/run.sh                      # per-PR default: 9 core checkers (campaigns + rotating guided seeds)
#   bash tear/run.sh all                  # all 9 core + 6 preventative safety models (campaigns + rotating guided seeds)
#   bash tear/run.sh scheduled            # full scheduled suite: all 15 checkers + BFS edges to depth 2 + 20 deep walks/core
#   bash tear/run.sh safety               # the 6 preventative safety models
#   bash tear/run.sh dispatch access      # named checkers only
#
# Environment:
#   TEAR_DATABASE_URL  Reuse an existing migrated, disposable-marked Postgres DB (single checker or shared).
#                      When unset, starts a throwaway postgres:17.11-alpine container in Docker and removes it on exit.
#   TEAR_SEEDS         Guided seed range per checker (default: rotates each run, e.g. 60 seeds for core;
#                      set to "" for campaigns only). Exact seed range is always printed for replay.
#   TEAR_EDGES         Set to 1 to enable the BFS edge-coverage pass (depth 2, access race d=4 / revoke d=5) on core checkers (default: 0; 1 in `scheduled`).
#   TEAR_DEEP_RUNS     Number of deep-prefix walks started from campaign cases per core checker (default: 0; 20 in `scheduled`).
#   TEAR_PG_PORT       Localhost port for the throwaway Docker Postgres (default: 55488).
#   TEAR_DIR           Optional local tear checkout passed to setup.sh if @tear/mbt or pinned CLI is absent.
#   TEAR_BIN           Optional explicit path to a tear binary (defaults to ~/.cache/nightmail-tear/<TEAR_REV>/bin/tear).
set -euo pipefail

TEAR_REV="97a42a263ccb8902f69daad185b0b558d1316277"
HERE="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$(cd "$HERE/.." && pwd)"
PIN_BIN="${TEAR_BIN_ROOT:-$HOME/.cache/nightmail-tear/$TEAR_REV}/bin/tear"
TEAR_BIN="${TEAR_BIN:-$PIN_BIN}"

if [[ ! -d "$HERE/node_modules/@tear/mbt/src" ]] || [[ ! -x "$TEAR_BIN" ]] || [[ "$(cat "$HERE/node_modules/@tear/.rev" 2>/dev/null || true)" != "$TEAR_REV" ]]; then
  bash "$HERE/setup.sh"
fi

CORE=(dispatch ses access admission inbox delivery campaign-lifecycle billing byo-regional)
SAFETY=(campaign-collab campaign-attachments db-faults scale-reads tenant-isolation workspace-isolation)

SCHEDULED_MODE=0
SELECTED=()
if (( $# == 0 )); then
  SELECTED=("${CORE[@]}")
else
  for arg in "$@"; do
    case "$arg" in
      core) SELECTED+=("${CORE[@]}") ;;
      safety) SELECTED+=("${SAFETY[@]}") ;;
      all) SELECTED+=("${CORE[@]}" "${SAFETY[@]}") ;;
      scheduled) SCHEDULED_MODE=1; SELECTED+=("${CORE[@]}" "${SAFETY[@]}") ;;
      dispatch|ses|access|admission|inbox|delivery|campaign-lifecycle|billing|byo-regional|campaign-collab|campaign-attachments|db-faults|scale-reads|tenant-isolation|workspace-isolation)
        SELECTED+=("$arg") ;;
      *) echo "unknown checker: $arg" >&2; exit 2 ;;
    esac
  done
fi

# Rotate default seeds on every run and print them so any failing run can be reproduced via TEAR_SEEDS.
SEED_BASE="${TEAR_SEED_BASE:-$(( ( $(date +%s) % 100000 ) * 100 + 1 ))}"
if (( SCHEDULED_MODE == 1 )); then
  TEAR_EDGES="${TEAR_EDGES:-1}"
  TEAR_DEEP_RUNS="${TEAR_DEEP_RUNS:-20}"
else
  TEAR_EDGES="${TEAR_EDGES:-0}"
  TEAR_DEEP_RUNS="${TEAR_DEEP_RUNS:-0}"
fi
CONTAINER=""
PORT="${TEAR_PG_PORT:-55488}"
SECRET="$(openssl rand -hex 36)"
TMP_EDGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nightmail-tear-edges-XXXXXX")"

cleanup() {
  rm -rf "$TMP_EDGE_DIR" >/dev/null 2>&1 || true
  if [[ -n "$CONTAINER" ]]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -z "${TEAR_DATABASE_URL:-}" ]]; then
  CONTAINER="nightmail-tear-$$"
  docker run -d --name "$CONTAINER"     -e POSTGRES_PASSWORD=tear     -p "127.0.0.1:$PORT:5432"     postgres:17.11-alpine     -c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null
  for _ in $(seq 1 80); do
    PGPASSWORD=tear psql -h 127.0.0.1 -p "$PORT" -U postgres -c 'SELECT 1' >/dev/null 2>&1 && break
    sleep 0.2
  done
fi

prep_db() {
  local name="$1"
  if [[ -n "${TEAR_DATABASE_URL:-}" ]]; then
    echo "$TEAR_DATABASE_URL"
    return
  fi
  local db="tear_${name//-/_}"
  local url="postgresql://postgres:tear@127.0.0.1:$PORT/$db"
  PGPASSWORD=tear psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q     -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db" >/dev/null
  (cd "$API_DIR" && DATABASE_URL="$url" BANE_ROOT_SECRET="$SECRET" PUBLIC_URL=http://127.0.0.1 node --import tsx src/migrate.ts >/dev/null)
  PGPASSWORD=tear psql -h 127.0.0.1 -p "$PORT" -U postgres -d "$db" -v ON_ERROR_STOP=1 -q     -c "COMMENT ON DATABASE $db IS 'bane-tear: disposable test database, every row may be changed or deleted'" >/dev/null
  echo "$url"
}

default_seeds_for() {
  local name="$1" count=60
  case "$name" in
    scale-reads) count=5 ;;
    tenant-isolation) count=20 ;;
    campaign-lifecycle|billing|byo-regional) count=30 ;;
    workspace-isolation) count=15 ;;
    campaign-collab|campaign-attachments|db-faults) count=40 ;;
    *) count=60 ;;
  esac
  echo "${SEED_BASE}..$((SEED_BASE + count - 1))"
}

run_one() {
  local name="$1" model_file="" campaign_file="" extra=() is_core=0
  case "$name" in
    dispatch|ses|access|admission|inbox|delivery|campaign-lifecycle|billing|byo-regional)
      model_file="$name/$name.model.ts"
      campaign_file="$name/campaigns/$name.json"
      is_core=1
      ;;
    campaign-collab|tenant-isolation|workspace-isolation)
      model_file="safety/$name.model.ts"
      campaign_file="safety/campaigns/$name.json"
      extra=(--rounds 2)
      ;;
    campaign-attachments|db-faults|scale-reads)
      model_file="safety/$name.model.ts"
      campaign_file="safety/campaigns/$name.json"
      ;;
  esac

  local db_url
  db_url="$(prep_db "$name")"
  local seeds=""
  if [[ -n "${TEAR_SEEDS+x}" ]]; then
    seeds="$TEAR_SEEDS"
  else
    seeds="$(default_seeds_for "$name")"
  fi

  echo "=== tear: $name (cli=$TEAR_BIN rev=${TEAR_REV:0:12} seeds=${seeds:-campaign-only}) ==="
  (cd "$HERE" && TEAR_DATABASE_URL="$db_url" "$TEAR_BIN" test "$model_file" "$name" --campaign "$campaign_file")

  if [[ -n "$seeds" ]]; then
    echo "=== tear: $name guided (seeds=$seeds) ==="
    (cd "$HERE" && TEAR_DATABASE_URL="$db_url" "$TEAR_BIN" test "$model_file" "$name" --seeds "$seeds" ${extra[@]+"${extra[@]}"})
  fi

  if (( is_core == 1 && TEAR_EDGES == 1 )); then
    local edge_file="$TMP_EDGE_DIR/$name-edges.json"
    (cd "$HERE" && bun edges.ts "$name" "$edge_file")
    echo "=== tear: $name exhaustive edges ==="
    (cd "$HERE" && TEAR_DATABASE_URL="$db_url" "$TEAR_BIN" test "$model_file" "$name" --campaign "$edge_file")
  fi

  if (( is_core == 1 && TEAR_DEEP_RUNS > 0 )) && [[ -n "$seeds" ]]; then
    local deep_seeds="${SEED_BASE}..$((SEED_BASE + TEAR_DEEP_RUNS - 1))"
    echo "=== tear: $name deep-prefix walks (seeds=$deep_seeds) ==="
    (cd "$HERE" && TEAR_DATABASE_URL="$db_url" "$TEAR_BIN" test "$model_file" "$name" --start "$campaign_file" --seeds "$deep_seeds")
  fi
}

for checker in "${SELECTED[@]}"; do
  run_one "$checker"
done
