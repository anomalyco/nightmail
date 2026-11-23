# tear: admission and rate limits (`admission`)

TypeScript `@tear/mbt` model and host for Nightmail's admission and rate-limit paths across three profiles:

- **`recv` (`recv0`–`recv3`):** Receive-side hourly message window, ingest backlog (`mail_ingest_admit`), two hosted workspaces `A < B`, multi-workspace notifications, reopen coalescing, 100/200-recipient bounds, `legacy-accept` overlap, global `release_receive_budget_holds(NULL)`, 72-hour hold expiry, 48-hour lost-receipt recovery (`recoverMailReceipts`), held-envelope replay, and the settle fence (migration 164, `legacy-fail`).
- **`send` (`send0`–`send1`):** Hosted send admission (`POST /v1/emails/send` and `/batch`), rolling 24-hour recipient cap shared across a quota sponsor's workspaces, marketing headroom reserve, pending cap, operator overrides (`set-hosted-limits`, `set-workspace-exemption`), pause/resume and sponsor-wide pause propagation, Idempotency-Key protocol (immediate `409 IDEMPOTENCY_IN_PROGRESS`, replay, conflict), per-key minute budgets (`GET /v1/me`), `hosted_adjust` refunds, and exact SQL statement counts.
- **`upload` (`upload0`–`upload1`):** Stored-attachment quota reservations (`POST /v1/attachments`), concurrent upload slots (`U1`–`U3`) paused at storage put, pending idempotency claims (`409 IDEMPOTENCY_IN_PROGRESS` / `CONFLICT` / `OUTCOME_UNKNOWN`), reservation expiry, upload tombstones, hourly reconciliation, deletion jobs, and foreign object survival.

Files:

- `admission.types.ts` — shared types and the 8 configuration presets (`recv0`–`recv3`, `send0`–`send1`, `upload0`–`upload1`).
- `admission.model.ts` — pure reference model, 10 idle rules (9 host-independent safety invariants + leaked errors), and 4 declarative temporal properties (`admission.recv.failed-final`, `admission.recv.legacy-fail-fenced`, `admission.upload.foreign-never-deleted`, `admission.send.idem-at-most-once`).
- `admission.host.ts` — Bun host driving real `app.fetch`, `acceptInboundNotification`, `recoverHeldReceipts`, `recoverMailReceipts`, `release_receive_budget_holds`, operator scripts, `cleanup`, `reconcileUploads`, and `drainJobs` over a disposable PostgreSQL database (`../disposable.ts`) with held transactions (`W`, `V`, `X`) and suspended storage puts (`U1`–`U3`).
- `campaigns/admission.json` — control, `admission.send.idem-at-most-once` canary, and 44 concrete regression and boundary scenarios.

## Run

From `api/tear/` (after `./setup.sh` and with `TEAR_DATABASE_URL` set to a plain loopback, migrated, disposable-marked Postgres database):

```sh
# Regression campaign (control + canary + 44 scenarios, ~2 s)
tear test admission/admission.model.ts admission --campaign admission/campaigns/admission.json

# Campaign + 50 seeded guided runs (~13 s)
tear test admission/admission.model.ts admission --campaign admission/campaigns/admission.json --seeds 1..50

# Deep exploration with novelty guidance (~137 s for 200 runs)
tear test admission/admission.model.ts --runs 200 --max-steps 24 --novelty --keep-going

# Replay a failing token
tear test admission/admission.model.ts admission --replay tpbt1_...
```
