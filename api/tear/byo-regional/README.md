# tear: `byo-regional`

Deterministic simulation model for Nightmail's BYO v5 regional provisioning, domain binding, operator pause fence, and disconnect cleanup against real PostgreSQL, `api/src/byo-regional.ts`, `api/src/provider-connections.ts`, and `api/src/jobs.ts` (`processJobs`) with mocked STS/SESv2/SNS SDK interceptors.

## Named invariants

1. `byo.no-orphan-pending-intent` — no open `byo_domain_intents` row (`closed_reason IS NULL`) or `sending_state = 'provisioning'` region may exist without an active `pending`/`running` backing job.
2. `byo.paused-never-deleted` — a paused BYO v5 connection cannot be deleted via `DELETE /v1/connection` or mid-flight `byo.disconnect`.
3. `byo.disconnecting-never-201-or-502` — all mutations while `state = 'disconnecting'` refuse cleanly with `409 CONNECTION_DISCONNECTING`.
4. `byo.exhausted-region-recoverable` — after region provisioning or bind retries exhaust, selecting the domain in a healthy region or retrying the fixed region succeeds without `409 DOMAIN_REGION_CONFLICT`.

## Running

```sh
bash api/tear/run.sh byo-regional
```
