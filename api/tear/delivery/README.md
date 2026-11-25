# tear: received-mail delivery (`delivery`)

TypeScript `@tear/mbt` model and host for Nightmail's received-mail delivery path: routing plan (exact routes, local-part patterns, `*@` catch-all, drop, disabled routes), rules/rituals (endpoint calls, 3-calls-per-endpoint cap, 32-intent budget and fail-to-junk), endpoints (webhook `W`, idempotent replay-safe webhook `V`, Slack `S`, pre-verified forward `F`, plain event subscription `U`), retries, exponential backoff (15 s × 4^(n−1), 12 h cap), `Retry-After` (7 d cap), per-endpoint rate limits, `Idempotency-Key`s, claim/attempt fences, pause/resume (held mail and generation bumping), delete, forward decline, loop suppression (`X-Nightmail-Loop`, or the earlier `X-Bane-Loop`, 24 vs 25 `Received` headers, missing `forwardEligible` verdict), and 30-day delivery retention.

- `delivery.types.ts` — shared types, helpers, and the 4 `retryAttempts` presets (`retries1`, `retries0`, `retries2`, `retries9`).
- `delivery.model.ts` — pure reference model, model invariant `check()` (`delivery.kept`), 5 idle rules (`delivery.attempts`, `delivery.kept`, `delivery.settles`, `delivery.no-duplicate-rows`, `delivery.no-leaked-errors`), and 2 declarative temporal properties (`delivery.once`, `endpoint.held`).
- `delivery.host.ts` — Bun host driving real `acceptInboundNotification`, `mailboxIngestJobs`, `mailboxEventJobs`, `processJobs` (two warm worker pools `K` and `L` with claim gate, crash/drop, and parked webhook transport), `pruneMailboxEvents`, `forwardStopUrl`, and `app.fetch` over a disposable PostgreSQL database (`../disposable.ts`).
- `campaigns/delivery.json` — control, `delivery.once` canary (`canary_double_start`), all 35 historical regression witnesses, 4 additional coverage cases (forward decline, 3-call/32-intent caps, `recv24`/`recv25` + drain, and `Retry-After` 7-day cap), and a pinned expected-fail canary for known product bug `DLV-1` (masked in `delivery.model.ts`: unpausing a plain event subscription `U` after an unrecorded send refills `jobs.attempts` to `0`).

## Run

From `api/tear/` (after `./setup.sh` and with `TEAR_DATABASE_URL` set to a migrated, disposable-marked loopback Postgres database):

```sh
# Regression campaign (control + canary + 39 concrete scenarios)
tear test delivery/delivery.model.ts delivery --campaign delivery/campaigns/delivery.json

# Campaign + 50 seeded guided runs
tear test delivery/delivery.model.ts delivery --campaign delivery/campaigns/delivery.json --seeds 1..50

# Deep exploration with novelty guidance
tear test delivery/delivery.model.ts delivery --runs 80 --max-steps 28 --novelty --subsets --keep-going

# Replay a failing token
tear test delivery/delivery.model.ts delivery --replay tpbt1_...
```
