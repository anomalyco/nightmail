# Nightmail consent, imports & unsubscribes tear checker

Model-based verification of a contact's consent and suppression state across every concurrent writer ("an unsubscribe always wins").

## Legitimate re-consent contract (pinned from `api/src/audience.ts` & `api/src/audience-query.ts`)

1. **Direct consent API (`POST /v1/contacts/{id}/consent`):** transitioning `unsubscribed -> subscribed` requires `confirmResubscribe: true` (else `409 RESUBSCRIBE_CONFIRMATION_REQUIRED`) AND `occurredAt > latest(audience_consent_audit.occurred_at)` (else `409 STALE_CONSENT`). Never lifts `suppressed`.
2. **AudienceQL bulk plan (`POST /v1/audience-query/apply`):** requires `confirmResubscribe: true` when any target is `unsubscribed` (else `409 RESUBSCRIBE_CONFIRMATION_REQUIRED`) AND every target's `updatedAt` must still match the plan snapshot (else `409 STALE_AUDIENCE_PLAN`). Never lifts `suppressed`.
3. **CSV import commit (`POST /v1/contact-imports/{id}/commit`):** restores soft-deleted rows (`deleted_at = NULL`) while preserving `marketing_consent` and `suppressed`. Without consent attestation, consent is unchanged (new contacts start `unknown`). With consent attestation, only `marketing_consent = 'unknown'` upgrades to `subscribed` — never `unsubscribed`, and never lifts `suppressed`.
4. **Profile edits (`PATCH /v1/contacts/{id}`), list membership changes, and `GET /unsubscribe/{token}`:** never change consent or suppression.

## Cross-workspace & SES suppression scope rule (Rule 6)

- **Database:** `audience_contacts` is strictly workspace-scoped (`UNIQUE (workspace_id, email)`). Unsubscribes, deletes, imports, bulk plans, and feedback suppressions in Workspace A never alter Workspace B's contact with the same email.
- **AWS SES (`api/src/mail-controls.ts`, `api/src/ses-setup.ts`):** Hosted/pooled mode enforces `SuppressionScope: 'TENANT'` (`['BOUNCE', 'COMPLAINT']`), keeping each tenant's SES suppression list isolated. Single-tenant BYO AWS mode uses `SuppressionScope: 'ACCOUNT'` for the customer's own AWS account + region.

## Named invariants (7)

| # | Rule ID | Invariant | Planted product bug (`plants.json`) |
|---|---|---|---|
| 1 | `consent.no-silent-override` | Unsubscribe, complaint, or hard-bounce suppression is never undone without legitimate confirmed re-consent | `cns-1-import-overrides-unsubscribed` |
| 2 | `consent.serializable-unsub-wins` | Concurrent writes match a serial order where every unsubscribe/suppression wins | `cns-2-bulk-plan-ignores-stale-unsub` |
| 3 | `consent.no-send-to-blocked` | Nobody unsubscribed, suppressed, or deleted before release/claim is sent to SES | `cns-3-dispatcher-sends-to-blocked` |
| 4 | `consent.evidence-preserved-and-order-independent` | `audience_consent_audit` is append-only and survives edits/list moves/delete-restore/#601 retention; `suppressed_at` is order-independent | `cns-4-suppressed-at-order-dependent` |
| 5 | `consent.tallies-exact` | API list tallies match raw SQL recount, non-negative, mutually exclusive, summing to total | `cns-5-list-tally-double-counts-suppressed` |
| 6 | `consent.workspace-isolated` | Workspace A actions never alter Workspace B's contact for the same email; Hosted SES `SuppressionScope === 'TENANT'` | `cns-6-unsub-leaks-across-workspaces` |
| 7 | `consent.limits-atomic` | 10,000 bulk cap, 50,000 CSV row cap, 50-property cap, 50 open-preview cap (#600), 429 rate limits, and 16 KiB property cap (`api/bounded-audience-reads`) fail whole cleanly | `cns-7-bulk-10k-limit-bypassed` |

## Running

```sh
# From api/ (campaigns + 30 rotating --rounds 2 guided seeds)
TEAR_DATABASE_URL="postgresql://..." bash tear/run.sh consent

# Full scheduled run (+ BFS edges + deep walks)
TEAR_DATABASE_URL="postgresql://..." bash tear/run.sh scheduled
```
