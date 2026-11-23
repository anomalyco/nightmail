# tear: send path (`dispatch`)

TypeScript `@tear/mbt` model and host for Nightmail's send path: admission (idempotency keys, pending cap), campaign lifecycle and pacing, batch dispatcher (runner drain, stepped D1/D2 processes, crashes, outage breaker, lease/claim/record fences, multi-owner fair leases, SES 24-hour quota and 10% transactional reserve), and interrupted-attempt recovery.

- `dispatch.types.ts` — shared types and the 10 configuration presets (`core`, `paced`, `throttle`, `pendingCap`, `owners`, `allowance`, `allowance2`, `quota2`, `quota3`, `quota4`).
- `dispatch.model.ts` — pure reference model, 16 idle rules (4 timing/pacing rules + 12 safety invariants), and declarative temporal property `dispatch.once`.
- `dispatch.host.ts` — Bun host driving real `app.fetch`, `runDispatcher`, `dispatchPartitions`, and `drainJobs` over a disposable PostgreSQL database with virtual time (`tear_clock`) and a fake `SESv2Client`.
- `campaigns/dispatch.json` — control, `dispatch.once` canary, and 32 concrete regression scenarios covering every boundary and interleaving.

## Run

From `api/tear/` (after `./setup.sh` and with `TEAR_DATABASE_URL` set to a migrated, disposable-marked loopback Postgres database):

```sh
# Regression campaign (control + canary + 32 scenarios, ~3.5 s)
tear test dispatch/dispatch.model.ts dispatch --campaign dispatch/campaigns/dispatch.json

# Campaign + 50 seeded guided runs (~14 s)
tear test dispatch/dispatch.model.ts dispatch --campaign dispatch/campaigns/dispatch.json --seeds 1..50

# Deep exploration with novelty guidance (~31 s for 150 runs)
tear test dispatch/dispatch.model.ts --runs 150 --max-steps 24 --novelty --keep-going

# Replay a failing token
tear test dispatch/dispatch.model.ts --replay tpbt1_...
```
