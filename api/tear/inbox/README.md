# tear: inbox phase 2 (`inbox`)

TypeScript `@tear/mbt` model and host for Nightmail's inbox phase 2: folders, per-folder UIDs, UIDVALIDITY, MODSEQ, flags, move/copy/expunge, folder purge, tombstones, counters, change sync, thread patches, and retention sweep under concurrent ingest and held-open transactions.

- `inbox.types.ts` — shared types and the 4 configuration presets (`full`, `quota1`, `unlimited`, `core`).
- `inbox.model.ts` — pure reference model (committed `db`, uncommitted `head`, per-connection lock model for `I`, `J`, `W`, `V`), 14 model-free idle rules over raw host snapshots, and 5 declarative temporal properties (`inbox.no-resurrection`, `inbox.uid-commit-order`, `inbox.uidnext-monotonic`, `inbox.highest-modseq-monotonic`, `inbox.modseq-monotonic`).
- `inbox.host.ts` — Bun host driving real `app.fetch` routes, `acceptInboundNotification`, `ingestInput`, `storeIncoming`, `attachToMailboxes`, `inbox_retention_batch`, and `inbox_prune_vanished` over a disposable PostgreSQL database (enforced by `../disposable.ts`).
- `campaigns/inbox.json` — control, `inbox.no-resurrection` canary, and 20 concrete regression and boundary scenarios.

## Retired legacy actions

The old Rust checker included three raw-SQL simulations of the pre-folder Worker (`legacy-read`, `legacy-thread`, `legacy-unread`) that asserted SQLSTATE `40001` from the temporary rollout fence triggers (`140_inbox_writer_fence.sql`, `152_inbox_fence_unread.sql`). Commit `f35379c9` (`324_addresses_are_inboxes.sql`) retired the old writer and dropped those triggers, so those three actions are no longer part of the contract.

## Run

From `api/tear/` (after `./setup.sh` and with `TEAR_DATABASE_URL` set to a migrated, disposable-marked loopback Postgres database):

```sh
# Regression campaign (control + canary + 20 scenarios, ~8 s)
tear test inbox/inbox.model.ts inbox --campaign inbox/campaigns/inbox.json

# Campaign + 50 seeded guided runs (~46 s)
tear test inbox/inbox.model.ts inbox --campaign inbox/campaigns/inbox.json --seeds 1..50

# Deep exploration (~145 s for 200 runs x 30 steps)
tear test inbox/inbox.model.ts --runs 200 --max-steps 30 --keep-going

# Replay a failing token
tear test inbox/inbox.model.ts inbox --replay tpbt1_...
```
