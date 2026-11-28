# tear: `billing`

Deterministic simulation model for Nightmail's Stripe money rail against real PostgreSQL (`billing_post`, `billing_ledger`, `billing_credit_lots`, `billing_blocked_cards`), real `api/src/billing/{stripe,stripe-webhook,stripe-jobs,routes}.ts`, a deterministic `globalThis.fetch` Stripe API interceptor, and HMAC-signed `/v1/billing/stripe` webhooks.

## Named invariants

1. `billing.zero-sum-ledger` — exact ledger sum equals `balance_uc`, every row's `balance_after_uc` matches the running sum, active credit lots sum to `max(balance_uc, 0)`, and credit and debt never coexist.
2. `billing.no-uncredited-debit` — disputing an uncredited attempt (`amount_mismatch`, `failed`, `expired`, `pending`) debits `0` and writes no dispute ledger row.
3. `billing.no-unbounded-recharge-loop` — wrong-amount, declined, 3DS, or blocked auto-recharge turns `recharge_enabled` off and never retries on subsequent ticks.
4. `billing.dispute-exact-reversal` — `won` and `warning_closed` reverse the exact dispute debit and lift dispute-only card blocks iff no other open/lost dispute or fraud warning exists; `lost` keeps the debit.
5. `billing.fraud-block-monotonic` — once `radar.early_fraud_warning.created` lands on a card fingerprint, its `early_fraud_warning` block is permanent and cannot be cleared by winning a dispute, saving a card, or enabling auto-recharge.

## Running

```sh
bash api/tear/run.sh billing
```
