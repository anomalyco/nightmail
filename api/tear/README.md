# Nightmail tear model-based test suite

Model-based tests for Nightmail built on the reworked TypeScript `tear` (`@tear/mbt` + `@tear/host`). Run on demand against a throwaway local PostgreSQL database with simulated/fake SES and storage — never production or dev.

Because `anomalyco/tear` is a private repository, `api/package.json` does not depend on it and public GitHub Actions CI does not run tear (public CI verifies the disposable-database guard on all 11 real `api/tear/**/*.host.ts` processes via a minimal stand-in). Install the revision-pinned `tear` CLI (`~/.cache/nightmail-tear/<TEAR_REV>/bin/tear`) and local `api/tear/node_modules/@tear/{mbt,host}` once via `api/tear/setup.sh`.

## Suite layout

Each checker uses split files: `<name>.types.ts` (pure shared types), `<name>.model.ts` (pure reference model, idle rules, and temporal properties — never imports `api/src/`), `<name>.host.ts` (Bun host driving the real Nightmail API/SQL/jobs), and `campaigns/<name>.json` (concrete control, canary, and regression cases).

### Core checkers (7)

| Checker | Area | Campaign cases |
|---|---|---:|
| `dispatch/` | Send admission, campaigns, batch dispatcher, quotas, outage breaker, recovery, virtual-second clock agreement, 5 timing/once rules | 36 |
| `ses/` | Hosted SES feedback (SNS route, queue consumer, recovery jobs, rank guards, stats, health) | 13 |
| `access/` | Idempotency reservations (including I7 authority hash), grant/key/token revocation & expiry, 243-op MCP vs REST parity (`BUG-ACCESS-01` tracked mask-free) | 18 |
| `admission/` | Receive hourly window, 48 h recovery boundary (47 h / 49 h) & backlog, hosted send caps & sponsor holds, upload quota reservations | 47 |
| `inbox/` | Inbox folders, UIDs, UIDVALIDITY, MODSEQ, flags, move/copy/expunge, tombstones, reopen job queueing, retention | 26 |
| `delivery/` | Routing, rules, endpoints, retries, backoff, rate limits, fences, pause/resume (`DLV-1` pinned) | 42 |
| `campaign-lifecycle/` | Full campaign life (draft → probe → sending → done/paused/canceled/failed), operational faults, crash/deploy, rate/view parity (migration 422), 8 named invariants | 20 |

### Preventative safety models (`safety/`, 6)

| Model | What is checked |
|---|---|
| `campaign-collab` | API optimistic locking under two editors + API caller: stale saves always `409 STALE_CAMPAIGN_REVISION`; concurrent `--rounds 2` races pick one winner. |
| `campaign-attachments` | Real PNG/PDF uploads, add/remove inline `cid:` images and files, `postal-mime` verification of every MIME part delivered to SES. |
| `db-faults` | Under DB read-only (`XX000`/`25006`), timeouts (`57014`/`55P03`), mid-request timeout after the first or second write, or pool exhaustion (`53300`), API replies are 2xx or `retryable: true`, one `Idempotency-Key` produces at most one email id and one SES send, a send to a suppressed recipient is never accepted (no phantom 202 replayed from its key), and healthy recovery drains all accepted mail. |
| `scale-reads` | On `TEAR_SCALE_CONTACTS` (default `200000`, up to `2000000`), dashboard reads return 200 within fixed (data-size-independent) latency caps AND indexed contact pagination reads pass `EXPLAIN (ANALYZE, FORMAT JSON)` with no full-table `Seq Scan`, large `Sort`, or full-workspace filter scan (`BUG-SCALE-01` pinned). |
| `tenant-isolation` | Workspace B's transactional sends return 202 within budget while overlapped deterministically inside workspace A's contact import commit transaction, and dispatch ahead of A's marketing backlog. |
| `workspace-isolation` | Nothing crosses between workspaces on any route: 276 OpenAPI routes, 31 support routes, 242 MCP tools, and every ID-carrying body/query/path field across 14 principals and 3 workspaces (`BUG-ISO-01`/#591, `BUG-ISO-02`/#611, `BUG-ISO-03`/#612 passing; `BUG-ISO-04`/#614 pinned until merge). |

## Quickstart

From `api/` (with `bun install` done and Docker running):

```sh
# One-time setup (installs revision-pinned CLI + @tear/{mbt,host}; TEAR_DIR must match TEAR_REV when a git repo)
bash tear/setup.sh

# Per-PR default: all 6 core checkers (campaigns + 60 rotating guided seeds each, ~5-6 min on exos; 20-160 s for one checker)
bun run tear:ci

# All 11 models (campaigns + rotating guided seeds, no edge pass)
bun run tear:ci all

# Full scheduled run: all 11 models + BFS edges to depth 2 (access race d=4, revoke d=5) + 20 deep walks/core (~15-16 min on exos)
bun run tear:ci scheduled

# Run a single checker against an existing disposable DB (seeds rotate each run and are printed for replay)
TEAR_DATABASE_URL="postgresql://postgres:tear@127.0.0.1:55499/tear_dispatch" \
  bash tear/run.sh dispatch

# Replay an exact rotating seed window (note: under heavy host load, inbox can occasionally hit tear's 10 s step timeout; replay the printed seed alone to confirm)
TEAR_SEEDS="12345..12404" bash tear/run.sh access
```

## Direct `tear` commands & planted-bug verification

From `api/tear/` with `TEAR_DATABASE_URL` set to a migrated, disposable-marked loopback Postgres database:

```sh
# Discover all 11 models
~/.cache/nightmail-tear/97a42a263ccb8902f69daad185b0b558d1316277/bin/tear mbt list

# Replay a counterexample token (use --start ... --masks run for masked known bugs; plain --replay skips masked steps)
tear test dispatch/dispatch.model.ts dispatch --replay tpbt1_...
tear test delivery/delivery.model.ts delivery --start tpbt1_... --max-steps 0 --runs 1 --masks run

# Re-verify the kept 21-bug planted product suite against a scratch checkout
TEAR_DATABASE_URL=... bun verify-plants.ts --scratch-root /path/to/scratch-nightmail
```

## Disposable database guard

Every `*.host.ts` validates `disposableUrl` and `assertDisposable` before registering exception handlers or writing anything, exiting non-zero with nothing on stdout on refusal. Public CI's `acceptance` shard runs all 11 real `*.host.ts` files against an unmarked database and a query-parameter URL and verifies workspace, schema, and table counts are unchanged (known limit: a host that inserts into an arbitrary pre-existing table before calling its guard is not caught by those counts alone).

```sql
COMMENT ON DATABASE tear_db IS 'bane-tear: disposable test database, every row may be changed or deleted';
```
