# CI: what runs where, and how to fix it

Every change reaches production through `dev`: a PR merges into `dev`, the dev deploy migrates the dev database, deploys the Worker and runs the live E2E (`api/scripts/e2e.ts`) against `dev.nightmail.dev`. Production requires a green live E2E and green dev merge-group CI (or full CI on a direct dev push) for the exact SHA.

## Merging into `dev`: the merge queue

`gh pr merge <n>` enqueues a PR. The queue is enabled on the **classic `dev` branch protection**, not the disabled `dev merge queue` ruleset. It merges onto the latest `dev` and the entries ahead of it only after the required `merge_group` checks (`build`, `acceptance`, `cls`, `preview`, `gateway`, `support`) pass. Only accounts allowed to push `dev` can enqueue.

- **Why:** with "require branches to be up to date", parallel PRs went BEHIND after every merge and re-ran CI each time; without it, two PRs that pass alone could break `dev` together (a migration number both picked, a route one added and the other's check missed). The queue removes both.
- **PR checks:** PRs from this repository run the full build and audit. Their five heavy suites wait for the queue; fork PRs still run every suite selected by their changed paths.
- **Full CI before queueing:** add the `full-ci` label to run every suite on the PR, even for docs-only changes.
  Remove it to return to the default; either label change starts a new PR run.
- **Path-gated checks:** the six required check names always report a result. A check passes only if its selected suite succeeded, or path detection succeeded and deliberately skipped it. Detection uses the PR merge checkout's first parent, or the **live dev tip** on a queue entry's first-parent chain (including pending PRs ahead of it). If dev has already advanced past the group, run everything.
- **Failures:** when a required check fails, CI waits up to three minutes for GitHub to record a failed-check ejection of that PR at that exact queue commit. It then comments with the failed checks and run link. Fix and re-add the ejected PR. Rebuilt followers and audit-only failures get no comment.
- **Deploys:** the queue pushes `dev` as `github-merge-queue[bot]`. The dev deploy accepts that push when the PR merged at exactly that commit was merged (enqueued) by thdxr or R44VC0RP; anything else still fails "Only thdxr and R44VC0RP may deploy".
- **Breaking API changes:** each queue entry is compared with its first parent, which already includes the PRs ahead of it. Only the `api-breaking` label on the PR supplying this entry's head can waive its breaks. An unlabelled entry must still pass, even if it undoes an earlier entry's change.

## Which changes select which suites

| Changed input | Suites selected on a fork PR or queue entry |
| --- | --- |
| Workflow, shared action, CI/deploy script, or dependency lockfile | Everything. Non-queue pushes to dev also run everything. |
| API code (including the hosted MCP), configuration, migrations or tests | Build (API types, both Worker bundles, pre-merge checks and generated contract/SDK), acceptance, preview and CLS (its fixture runs this API's migrations, server and read limits and seeds its tables with raw SQL). Bundling needs Vite's static assets, not a separate dashboard type-check. |
| Dashboard including bundled legal Markdown | Dashboard build and pre-merge checks, Worker bundle/preview and CLS. Acceptance also exercises asset-headers, the theme and signed-in scripts, shared lib, data types and Settings helpers. |
| API code used by the dashboard | Also the dashboard build: `api/openapi.json` (rendered in Docs), and `api/src/{analytics-events,billing/rates,block-style,brand,mcp-clients,ritual-schema,standing-model,webhook-signature-guide}.ts`. The dashboard does not import the generated SDK. |
| SDK or standalone MCP client code | Build (type-check the SDK consumer and regenerate the contract/SDK) and acceptance. |
| Support Worker | Support, including its bundled system prompt and voice guide. Also selected by its API dependencies: brand, log, billing rates, mail-servers, the output gate, plain text and the production Wrangler config. |
| Gateway | Rust format, lint and tests. |
| Other fixture/test inputs | Acceptance for Domain Connect templates, shared AWS policies, the Pulumi receiving alarm, the S3 fixture, `api/README.md`'s executable example or the asserted `docs/mcp-coverage.md`. |
| Other Markdown/docs | No heavy suites. Nightly still runs the full acceptance and CLS suites on dev. |

`audit` runs on every PR, queue entry and direct dev push: advisories are published against unchanged lockfiles, and production's proof is that run's conclusion. The routing table lives in `.github/scripts/ci-scope.sh`. Update it when a suite starts reading files outside its package. Renames select both the old and the new path.

## What runs where

| When | Job | What it proves |
| --- | --- | --- |
| PR, merge group, direct `dev` push | `build` | Types, SDK and docs regenerate cleanly, both Workers bundle, the public API stays compatible, and the **pre-merge invariants** below |
| PR, merge group, direct `dev` push | `acceptance` | Four isolated Postgres/S3 shards (two integration, two simulated), each with the **deadlock guard** |
| PR, merge group, direct `dev` push | `preview` | The real Worker under `wrangler dev` on a database upgraded from `dev`'s schema; see **Preview stack** |
| PR, merge group, direct `dev` push | `audit`, `gateway`, `cls`, `support` | Dependency advisories, the Rust mail gateway (selected by the table above), layout shift on every main page across nine independent runners, and the support Worker tests on two fixtures |
| Every `dev` push | Deploy dev | Migrate, deploy, health and live dev E2E. Support prepares alongside the main Worker but waits for its health check before changing D1 or its service binding. |
| Daily 07:17 UTC, or by hand | Nightly | The acceptance suite (quarantined tests included) and the CLS gate, once each by default (5, 10 or 20 by hand), reported in one issue |
| `production` push | Deploy production | Requires a passing live dev E2E and CI proof (see **Releasing to production**) |
| Daily 03:00 ET, on Ryan's Mac | Nightly report | The last 24 hours of production and dev logs against the previous week; files `nightly` issues and starts a self-improve session (below) |
| On demand (`api/ bun run tear:ci`) | Model-based tear suite | Runs on demand against a disposable local Postgres (`anomalyco/tear` is private); public CI's `acceptance` shard verifies the disposable-DB guard on all 11 real `api/tear/**/*.host.ts` processes |

CI, nightly and deploy use Blacksmith Ubuntu 24.04 (4 vCPUs for builds, tests and deploys; 2 for the PR/queue acceptance and support shards and lightweight checks). `release.yml` stays on GitHub-hosted runners for npm trusted publishing. Blacksmith routes `actions/cache` to its local cache. Postgres runs on tmpfs; the CLS cache holds the locked Playwright browser and an exact-SHA Vite build, never a deploy artifact. Each protected suite check requires every selected matrix job to succeed. Acceptance, support and CLS also require a report from each expected shard and check the sum against the unsharded inventory (production and TV separately for CLS). Acceptance counts runnable registered cases; opt-in skips and nightly-only quarantines are excluded, and nested subtests run with their parent.

## Releasing to production

1. **Prove the commit.** Merge to `dev`. Wait for the main dev deploy and its live E2E for the merge SHA. Its successful `ci.yml` run on `gh-readonly-queue/dev/…` already proves the exact commit; the queue bot’s all-skipped dev push CI is never proof. A direct dev push still needs full push CI. PR checks or a green result for a different SHA do not count. Nothing ships to production automatically.
2. **Promote it.** Fast-forward `production` to that SHA: `git push origin <sha>:refs/heads/production`. Only this push starts a production deployment. Under the stage lock, Authorize checks that the SHA is on `dev`, descends from the last healthy production deploy and has both proofs. Only `thdxr` and `R44VC0RP` may push; privileged jobs recheck the branch tip and the `PROD_DEPLOY_ENABLED` freeze switch. No separate reviewer approval is needed.
3. **Verify it.** Watch the production push run through the Worker (`/health` and `/health/ready`, which loads the full runtime and verifies PostgreSQL) and support health checks. The branch names the release; if a push is pending or fails, `GITHUB_REPOSITORY=anomalyco/nightmail bash .github/scripts/deployed-sha.sh production` reports the last healthy main Worker SHA. Retry the full push run while it is still the tip, or fix forward. To undo a change, prove a revert on `dev` and fast-forward to it; never move `production` backwards.
4. **Emergency rollback (< 10 seconds).** If a bad Worker deploy spikes errors and waiting ~10–15 minutes for a revert through `dev` is too slow, run `wrangler rollback --config api/wrangler.prod.jsonc` from `api/` (safe only when the bad deploy ran no destructive or incompatible schema migration). Immediately follow up with a revert PR on `dev` and fast-forward `production` to it so Git history and `deployed-sha.sh` match live production again.

**Pulumi only runs when it has work.** `.github/scripts/pulumi-has-work.sh` compares the commit being deployed with the last healthy main Worker SHA for that stage, not the previous branch tip. Pulumi runs when one of these changed in that range:

- `infra/`, except Markdown and the other stage's stack settings;
- `api/src/mail-controls.ts`, the token action, or the script that checks the receiving set;
- the `pulumi` job in `deploy.yml`, including its CLI version, after expanding anchors and ignoring its `Require …` guard steps, the equivalent Ubuntu runner labels and the download-cache step.

An edit to the verifier or scope script alone still runs the live tenant-routing check, before the main Worker migrates. A missing or non-ancestor base, unknown job change or manual dev dispatch requires Pulumi. No token is shared between jobs: each Cloudflare caller mints and uses its own IP-bound token.

## When the dev E2E fails

The deploy's `Report the dev E2E failure` job opens an issue labeled `dev-e2e` (or comments on the open one) with the failed steps, their errors and request IDs, and the nightmail-dev Worker's log lines for those requests. Those lines come from `wrangler tail`, which runs during the E2E; they are limited to the failed requests and to Nightmail's structured fields (level, code, route, status, SQLSTATE, a 300-character message; see **Request logs** below) because the issue is public. If the dev token cannot tail Workers, the issue says so and you search the request IDs in the Cloudflare dashboard instead.

Production stays blocked, as before: it deploys only a commit whose dev E2E passed. To unblock:

1. Read the issue: the failed step and request ID usually name the operation and the error code (a `40P01` is a deadlock: see the deadlock guard below). The Worker log section quotes the failed requests' lines, plus every server error and exception the tail saw during the run. A step's last request is often a successful status poll that the tail sampled away.
   A campaign held with `hosted_daily_quota` means the fixture's capacity, which the deploy sets before the E2E (`api/scripts/dev-e2e-fixture.ts`, see `api/README.md`).
2. Fix forward in a PR. If the failure was flaky rather than a regression, say so in the issue and re-run the deploy for the same SHA.
3. Close the issue once a dev E2E passes.

## Pre-merge invariants (`build`)

`api/scripts/check-premerge.ts` runs in about five seconds. Run it locally from `api/` with `node --import tsx scripts/check-premerge.ts` (it compares against your merge-base with `dev`). Each failure is an annotation on the PR's Files tab.

### E2E coverage

**Fails when** an operation in `api/openapi.json` is neither called nor skipped in `api/scripts/e2e.ts`. The live dev E2E fails on exactly this after merge (it happened twice).

**Fix:** add a step that calls `api('yourOperation', …)` against dev. If it can't run there (it needs a dashboard session, would change the shared fixture, or needs AWS resources the run doesn't own), add it to `SKIP` with that reason. An operation called only in a loop of names (`for (const op of ['a','b'])`) counts, because the names are string literals.

### Worker routes

**Fails when** an API route (from `createOpenApiApp()`) is not matched by `assets.run_worker_first` in `api/wrangler.dev.jsonc` or `api/wrangler.prod.jsonc`, when the two configs' `assets` blocks differ, or when `src/worker.ts` hands a GET for an API path to the static assets binding.

Workers Assets answers any path outside `run_worker_first` itself: a 405 for a POST, the dashboard's `index.html` for a GET. The Node server and the acceptance suite never see this, so a new prefix (as `/internal/*` was) works in CI and breaks on Cloudflare.

**Fix:** add the prefix (`"/yourprefix", "/yourprefix/*"`) to `run_worker_first` in both wrangler configs, and to the API path pattern in the Worker's `fetch`.

### Migrations

`src/migrate.ts` records applied filenames and SHA-256 checksums in `nightmail_migrations` and applies every unapplied `NNN_name.sql` in file-name order, refusing any already-applied migration whose contents changed. Any unused three-digit number is accepted so independent PRs can merge in any order; open-PR collisions are caught when the second PR merges. Because a fresh install applies migrations in number order while an upgraded database applies newly merged lower-numbered migrations after higher-numbered ones it already ran, a later-merged lower-numbered migration must not depend on a higher-numbered one. **Fails when:**

- a file in `api/migrations/` doesn't match `^\d+_[a-z_]+\.sql$` (migrate.ts would silently skip it: no digits or capitals after the number);
- two files share a number (the historical pairs from before this check are listed in the script and stay);
- a new migration reuses a number that is already on the base branch;
- a migration that is on the base branch was edited, renamed or deleted (every upgraded database would fail with `MIGRATION_CHANGED`).

**Fix:** rename your file to an unused number (the message suggests the next free number above the current highest).

### Card slots

Below 640 px every `DataTable` renders its rows as cards from each column's `card` slot (see `AGENTS.md`). **Fails when** a PR adds a table column (an object with `key`, `label` and `render`) without `card`. Columns that existed before the check are grandfathered by file and key.

**Fix:** set `card` to `'title'`, `'aside'`, `'line'`, `'inline'`, `'field'`, `'end'` or `'hide'` (see `Column` in `app/src/components/ui/primitives.tsx`).

### Identity

Identity is `(issuer, subject)`. An issuer can assert a verified address that the sign-in method never vouched for (a GitHub-made account that links a personal Google account signs in with `acr=google` and its GitHub-verified work address), so no code may admit, link or authorize a person by email. **Fails when** `api/src`, `api/scripts` or a migration from 270 on names one of the removed email paths (`claim_bane_legacy_user`, `bane_legacy_claims`, `AUTH_ALLOWED_EMAILS`, `AUTH_ALLOWED_DOMAINS`, `allowedEmails`, `allowedDomains`, `signupApproved`, `google_hosted_domain`).

**Fix:** decide by subject: the sign-in's provider identity for hosted staff (`api/src/account-policy.ts`), an invitation link, `AUTH_ALLOWED_SUBJECTS` when self-hosted, or an operator binding a subject (`scripts/list-signin-attempts.ts`). A line that must name a removed setting, such as the startup refusal, carries `premerge-identity: allowed`.

### Permissions

Every registered operation states what it needs: `x-nightmail-permission` in the full contract (and in `api/openapi.json` for published operations), from its row in `api/src/operation-permissions.ts`. A row records what the operation's guards enforce today: a permission and level with the scope, role or kind of credential it also needs, a person, or no credential. The docs and MCP `describe_tool` show it. The acceptance test `permission table` calls every operation with keys, keys limited to addresses or one inbox, people of each role, an owner's MCP sign-in approved for each level and agent tokens, and fails when a row admits or refuses a credential that REST does not. It then calls every scoped row on real resources inside and outside a limited key's sender domain or addresses: inside, the key must reach the handler's own answer (not a refusal, not the 404 that hides what is outside a key's limits); outside, it must be refused or hidden.

**Fails when** an operation has no `x-nightmail-permission` or an invalid one, or the table has a row for an operation that no longer exists.

**Fix:** add or update the row in the same change as the route or guard, run `bun run sdk` in `api/`, then run the `permission table` acceptance test.

### Operation summaries

An operation's `summary` is its name: the docs page's title in the browser tab and in search results (`<summary> · Nightmail API docs`), the docs sidebar's entry and the SDK's comment, and an MCP tool's description leads with it. **Fails when** a summary has a full stop, colon or semicolon followed by more words, or makes a docs title longer than the 60 characters a search result shows (a summary of at most 39 characters).

**Fix:** keep a short name ("Create an inbox app password") and move the sentence, word for word, to the start of the operation's `description`, a warning ("Password shown once") first. Then run `bun run sdk` in `api/`.

### Accepted mail stamp

Every statement that inserts into `sending_email_events` gives `created_at`, in its own projection, exactly `clock_timestamp()` or `CASE WHEN <type>='accepted' AND NOT <simulated> THEN clock_timestamp() ELSE … END`, or carries `/* premerge-accepted: never (why) */` right after its column list.

The abuse sample records how far it has read each workspace (`api/src/abuse.ts` `sampleBound`). It relies on this: an insert takes its write lock on the table when the statement starts, before any row is stamped, so a `clock_timestamp()` stamp is never earlier than the lock. A stamp from `now()`, `transaction_timestamp()` or `current_timestamp` (the transaction's start), from `statement_timestamp()` (just before the lock), from the column default or from another clock can become visible behind the mark and never be read. The check parses the value in `created_at`'s position, so a `clock_timestamp()` elsewhere in the statement doesn't count.

**Fails when** an insert gives `created_at` anything else for accepted mail, leaves it to the default, or can't be read as `INSERT … (columns) SELECT/VALUES …`. **Fix:** stamp accepted mail with `clock_timestamp()` in the insert, or add the marker if the statement never writes type `accepted`.

### Announced changes

A change to the legal pages that takes effect later (`api/src/policy-changes.ts`) has the day it was announced and the day it takes effect. The pages show that day as their updated date, and the build refuses a change that takes effect less than 31 days after it (`app/legal-markdown.ts`: 30 days' notice, and a day for it to reach production). **Fails when** a pull request adds a change or edits its `announced` day to anything but the day the check runs (UTC). In the merge queue that is the day it merges, so a change written on Friday and merged on Monday fails until its day is Monday's.

**Fix:** set `announced` to today. If that leaves less than 31 days before `from`, the build says so: move `from` too, and the wording that names it follows by itself. A pull request that doesn't touch the days isn't checked.

### BYO role templates

Connected AWS accounts run a published role template (`api/byo-templates/<major>.<minor>.yaml`, served from S3 as `byo/<version>.yaml`), and Nightmail must keep working with every supported version. **Fails when** a published file was edited, renamed or deleted, a new file isn't named `<major>.<minor>.yaml`, or a new version isn't newer than the newest published one.

**Fix:** revert the published file and add the change as a new version. A minor version only adds permissions. The acceptance test `BYO contract` checks every session the code asks for (`api/src/byo-permissions.ts`) against the current draft and every published version; a call outside its session policy fails the BYO v5 enrollment test.

### Price pages

The public price pages (`/pricing` and `/compare/*`, `app/src/features/pricing`) compare Nightmail with named competitors, so a wrong figure is a false claim. The check renders them with React as a browser gets them, at their own sizes and at inputs a visitor might type (empty, negative, decimals, commas, past a billion). **Fails when:**

- a Nightmail figure isn't what `api/src/billing/rates.ts` charges for the usage it is marked with (`data-nightmail-sent` and `data-nightmail-received`), or the pages don't quote the rate, the free allowances, storage, or the top-up minimum and expiry (`CREDIT`) as the billing code has them;
- a competitor price in `prices.ts` has no source, or a source lacks an https link to the vendor's page, the day it was read (not in the future) or the text it was read from;
- a competitor row has no date and link, or a comparison shows a size without a verified price.

**Fix:** take prices from `rates.ts` and `prices.ts`, never as literals in the page; give a new figure its `source`. A price that changed is re-read on the vendor's page and updated in `prices.ts` with the new day; one that can't be re-read is removed, not left stale. The pages stay out of the site's links and search engines until `PRICE_PAGES_LIVE` in `app/src/features/pricing/live.ts` is true.

### Design rules (report only)

`app/scripts/design-lint` checks the dashboard against its design rules: no borders or outlines, no focus rings, one surface step, colours, spacing, radii and font sizes from tokens, Inter and OpenTUI Mono only, Lucide icons only, full-width pages and whole labels. Stylesheets go through Stylelint (`nightmail/<rule>`), components through the TypeScript AST. Each violation gives its place, the rule, why the rule exists and what to use instead. The homepage, price and legal pages are outside the console and not checked.

**Reports, never fails,** while every rule in `app/design-lint.config.ts` is at level `report`. A rule set to `error` fails here on any violation.

**Fix:** do what the violation's `use` line says. In `app/`, `bun run design-lint <files>` checks only the files you changed, `--rule <id>` one rule, `--json` gives the list to an agent. A sanctioned exception goes in the rule's `allow` list in the config with its reason, or on the CSS line as `/* stylelint-disable-next-line nightmail/<rule> -- <reason> */`.

## Deadlock guard (`acceptance`)

Dev's E2E runs its steps concurrently, and every 40P01 it has hit so far was two endpoints locking the same rows (the workspace's settings row, a domain claim, a receipt or its window) in opposite orders. Each request then failed with a 500 after `deadlock_timeout`. The acceptance job now:

- sets `deadlock_timeout = 50ms` and `log_lock_waits = on` on its Postgres (a cycle is found in 50 ms, and every longer wait is logged) and `lock_timeout = 15s` for the fixture role (a stuck lock fails one statement instead of the job);
- runs `lock order: concurrent domain re-adds, sends and mailbox replies on one domain never deadlock`, which fires the pairs behind every dev 40P01 so far (re-adding a domain while sends and mailbox replies from it are admitted) 600 times in one to two seconds. With either fix reverted (PR #63's send order or PR #100's mailbox-send order, today's `createDomain` 500) it hits 90 to 140 deadlocks on every run;
- fails if Postgres counted **any** deadlock during the whole suite (`pg_stat_database.deadlocks`), even one a retry absorbed or no test asserted on, and prints each cycle from the Postgres log.

**When it fails:** the log excerpt names both statements and the rows they waited for. Find the two code paths and make them take their locks in the same order: the workspace's `ses_installation_settings` row first, then domain claims, then receipts and their windows (`lockedSettings()` in `api/src/sending.ts` is the helper). Add a test that holds the first lock and proves the second path waits for it (see `regional sender: a send waits on the settings row…`), and add the pair to the `lock order:` stress test once it is fixed.

Locally: `PGPORT=<port> PG_CONTAINER=<container> RUNNER_TEMP=$(mktemp -d) bash ../.github/scripts/acceptance.sh` from `api/`, against a disposable Postgres (`docker run -d -e POSTGRES_PASSWORD=fixture-admin -p 127.0.0.1:<port>:5432 postgres:17.11-alpine`). The suite listens on ports 8787, 8788, 4569 and 4570; when another checkout's suite is running, pick others with `ACCEPTANCE_PORTS="18787 18788 14569 14570"`.

## Flakes: quarantine and the nightly runs

A flaky check costs every PR a re-run and teaches everyone to ignore red. The policy:

- **Fix it first.** Most flakes are a race with something else in the shared fixture, or a measurement that depends on timing. Two fixed this way: `database connection refusals…` claimed whichever job was due, so under the full suite it could take another test's job (it now shadows the queue with a transaction-scoped `CREATE TEMP TABLE jobs (LIKE public.jobs INCLUDING ALL) ON COMMIT DROP`, as the campaign-run tests do); and the CLS gate's `Settings · webhook` phone measurement (below).
- **Quarantine while you fix it.** Open an issue, then add `[flaky #<issue>]` to the test's name. The required `acceptance` job skips it; the nightly runs it. `check-premerge.ts` fails the build if the tag names no issue or a closed one. Remove the tag when the fix lands, or when the nightly report lists it as passing every run.
- **The nightly finds new ones.** `.github/workflows/nightly.yml` runs the acceptance suite (`ACCEPTANCE_QUARANTINE=all`, JUnit output) and the CLS gate on the dev tip, once each by default, then keeps one issue labeled `nightly-flakes` current: each failing test or CLS measurement with its failure count and first error, run-level failures (a deadlock, a crashed shard), and quarantined tests that passed every run. A clean night closes the issue. Run it by hand from the Actions tab (5, 10 or 20 runs).

`acceptance.sh` modes: `ACCEPTANCE_QUARANTINE` unset skips quarantined tests, `only` runs just them, `all` runs everything; `ACCEPTANCE_JUNIT=<dir>` also writes `integration.xml` and `simulated.xml` there.

### CLS shards

PR/queue CI hashes each shared measurement's page, viewport/theme and mode across eight Postgres/browser fixtures. A ninth runs the exclusive pages one at a time and the television build, and a tenth (`docs`) the painted docs pages' comparison, beside them. Each job keeps its original global page index, network timing, viewport, theme and 0.001 threshold. A failing shard uploads its own shift sources. Local and nightly runs default to the whole production list; to reproduce one CI shard use `CLS_SHARD_INDEX=0 CLS_SHARD_COUNT=9 bun run cls` from `app/` (indices 0–7 or `alone`).

### CLS: web fonts load before any text, every run

The CLS gate's `Settings · webhook` phone measurement failed on dev twice on Nov 12 (CLS 0.0334; re-runs passed): the event-type checkboxes grew 7% and "Complaint" wrapped onto the next line when Inter arrived. Inter is 7.2% wider than Arial, and `Inter Fallback` (sized for Arial) named only `Arial` and `Helvetica`, which Linux doesn't have, so CI's first paint used unsized Liberation Sans. Whether text painted before Inter arrived depended on the runner's load.

- `cls.mjs` serves web fonts at once from `app/dist/fonts`, outside the throttled network, so they have loaded before the throttled script that renders any text runs. Font timing no longer varies between runs. `CLS_FONTS=late` delivers every font 1.8 s late instead, to look at the fallback-to-web-font swap itself (it also fails a page if a fallback face has no local font).
- `tokens.css`: the fallbacks also name their Linux metric twins (Liberation Sans for Arial, DejaVu Sans Mono for Menlo), so readers without Arial get sized fallbacks too.
- Docs' text measures were in `ch` (the width of the current font's `0`, which changes when the font swaps); they are in `em` now.

With late fonts the fallbacks keep most pages still, but no fallback wraps every string exactly like Inter at a 0.001 limit (on Linux, Onboarding's option cards at phone width wrap one line differently, 0.0071), so the gate measures layout with the real fonts and the late-font mode is for investigation.

**When CLS fails only sometimes**, look for something whose size depends on timing: a font swap (a `ch` width, text measured before the font loaded, a fallback without local metrics), an image without dimensions, or content that arrives after its placeholder with a different size. Make the gate reproduce it every run, then fix the page. Never raise the limit.


### CLS: painted pages

The price, legal and docs pages are painted from their own HTML before the app's code, and the app takes over at the reader's first key (`app/painted-page.ts`). The gate wakes each one with a key, so the painted page and the takeover are both measured.

- **Fails when** a legal or docs page's words (`innerText`, the frame and the contents included) differ from the app's once it has taken over: "the painted page's words differ from the app's after it takes over, at character N". The `docs` shard, a runner of its own beside the CLS shards, reads every docs page so (`app/scripts/docs-sweep.mjs`, 20 to 45 s: all at 1440 × 900 light, the overview and guides also dark and at 390 × 844), and fails the same way, naming the page and view and, for a page that isn't painted or isn't taken over, what it asked for that didn't come. **Fix:** the painted page is drawn by the app's own components (`features/legal/prerender.tsx`, `features/docs/prerender.tsx`), so a difference is state the app sets after its first frame or data it reads that the build doesn't. Draw it from the first frame, or give the build the same data.
- **The docs pages are painted for one address** (their examples name it; `public/theme.js` shows them only there, `data-origin`). The gate's build is made for `http://127.0.0.1:47173` (`VITE_PUBLIC_URL` in `.github/actions/cls-build` and `bun run cls`), and the fixture's first server takes that port; `cls.mjs` reads the address from the build and sends the docs pages there. A build without `VITE_PUBLIC_URL` paints no docs page, and the gate measures the docs as before.
- **The docs overview is painted only at its own sections' hashes** (`data-anchors`, its element ids); at any other, such as `/docs#guide-rituals`, the app draws it from the start and moves it (`features/docs/index.tsx`, `legacyPath`, the one list of old addresses). The build stops if one of the overview's ids is an address `legacyPath` moves.

## Preview stack (`preview`)

`.github/scripts/preview.sh` runs what dev runs, before merge, with no Cloudflare or AWS account (about 15 s after installing and building the dashboard):

1. **Migrations, fresh and upgraded.** `dev`'s migrations (from the commit the PR lands on) then the PR's, on one database; the PR's alone on another. Both must apply, and `pg_dump --schema-only` of the two must be identical. A migration numbered before one `dev` already applied changes the column order between them, so this fails with "renumber".
2. **The real Worker.** `wrangler dev` (workerd) with `wrangler.dev.jsonc` as is: `assets` and `run_worker_first`, Durable Objects, queues, rate limits, crons. Only what exists solely on Cloudflare is dropped (custom domain, account, placement, Browser Rendering, observability). Hyperdrive points at the upgraded database, and SES is simulated.
3. **Every route reaches the Worker.** `api/scripts/preview-smoke.ts` asks each of the ~290 routes anonymously. Each must answer with an `x-request-id` and below 500, so Workers Assets never answers (405 or the dashboard HTML) and no module fails to load in workerd. The dashboard's own paths must still serve its HTML, and the scheduled handler runs once.

**When it fails:** the annotation names the route or the schema difference. For a route, add its prefix to `run_worker_first` in both wrangler configs (the `build` check usually catches it first). For a schema difference, renumber the migration after `dev`'s newest. For a 5xx, find the request ID in the job's wrangler log. Locally, from `api/` with the dashboard built and a disposable Postgres: `BASE=$(git merge-base HEAD origin/dev) PGPORT=<port> PG_CONTAINER=<container> bash ../.github/scripts/preview.sh`.

### Next: the E2E flow itself in preview

`api/scripts/e2e.ts` does not run here yet. It needs a hosted workspace in simulated mode: a seeded workspace, key, ready shared connection and verified domain. It also needs a `preview` profile that expects simulated receipts, and skips by operation ID the steps that need AWS (domain verification, the MX check, the inbound self-loop through SES receiving, Browser Rendering). That would run the E2E's concurrent steps, the source of the dev 40P01s, under workerd before merge. Estimated one to two days, including making it reliable enough to require.

### Why not a Cloudflare preview deployment per PR

A Workers preview version per PR (`wrangler versions upload --preview-alias pr-<n>`) runs on real Cloudflare, but:

- Preview versions don't consume queues or run crons, and they share dev's queues, R2 buckets and Durable Objects. Isolating data needs a database branch per PR (PlanetScale bills branch hours) and a Hyperdrive config per branch.
- PR workflows would need the Cloudflare token and the AWS role: credentials next to unreviewed PR code.
- It is real infrastructure to provision, clean up and pay for, and it still wouldn't cover live SES or inbound mail.

The local workerd stack catches the classes that hit dev (routing, module loading, migrations) for free and without credentials. Recommendation: keep it. If live-provider coverage before merge is ever worth paying for, use one shared staging fixture, not one per PR.

## Request logs

Every process logs one JSON object per line (`log` and `logError` in `api/src/core.ts`): the Worker to Workers Logs (`observability` in both wrangler configs, 100% head sampling), the Node API and runner to stdout (CloudWatch on Fargate), and the mail gateway to CloudWatch `/ecs/nightmail-mail-gateway`. Each line carries `service` (`worker`, `api`, `runner`, `gateway`) and `deploy`, the first 12 characters of the commit (`DEPLOY_SHA`, which `deploy-worker.sh` sets on the Worker; set it in the environment for Node).

- **One request line per request** (`event: "request"`, written by the first middleware in `app.ts`): `requestId`, `route` (the matched handler's template, such as `/v1/emails/:id` or `/mcp`, or `unmatched`; never the raw path), `method`, `status`, `code` and `field` for a failure, `databaseCode`, `durationMs`, `workspace` (the workspace ID only), `principal` (`apiKey`, `dashboard`, `mcp`, `agentToken`, `inboxKey`, `gateway`, `anonymous`) and per-step `timings`. Level: `info` below 400, `warn` for 4xx, `error` for 5xx. `field` names only the schema's own top-level fields: an unsupported key is whatever the caller sent, so it is never logged. MCP authenticates and answers inside its route, so `/mcp` records its principal and a failure code itself (`MCP_AUTH_REQUIRED`, `AUTH_UNAVAILABLE`, `ORIGIN_NOT_ALLOWED`, `MCP_HTTP_<status>`).
- **One error line per unexpected failure** (`logError`): the same `requestId` (or `jobId` for a job), `code` (an upper-case code string, else `UNKNOWN_ERROR`), `errorType` (a string `name` shaped like a class name, else `Error`), `databaseCode` (a five-character SQLSTATE string from the `cause` chain), `schema` when one of our own parses refused a value (a route checking its answer, a stored value read back: up to five issues as `path: what was wrong`, such as `readiness.plan.batches.2: expected int, received number`; indexes and only the field names the API publishes, any other key `*` (a record's or map's key is a customer's: a contact property, a metadata key, an address) and a record's refused key always `*`, then only Zod's own words, such as the kind of value received, never the value or an issue's message; `schemaIssues` in `api/src/log.ts`, with the names in `api/src/api-field-names.ts`, which `bun run openapi` generates from `openapi.json` and the build job checks like the spec) and up to 12 stack frames from Nightmail's own code (the Worker bundle, `src/` or `dist/`), rebuilt as `function (file:line:column)`. Never a message, neither the error's nor an `ApiError`'s: a database error's message quotes its parameters, and an error's name is just a property, and either can span lines that look like frames. So `stackFrames` reads frames only after the exact `name: message` header text (matched by characters, not lines), and logs no frames when the stack does not start with it.
- **Sampling:** successful requests are logged 1 in 10 and routine job and queue successes 1 in 100. A kept line carries `sampleRate`, so a count is the number of lines divided by it. Failures, warnings and errors are always logged, and so is any request or job that took 2 seconds or more (`SLOW_REQUEST_MS` in `api/src/log.ts`; a slow request line carries `slow: true` and no `sampleRate`, so it counts once).
- **Counted as well as logged:** every request adds to per-route counters with a latency histogram (`api/src/health-counters.ts`), kept by minute for two hours and by hour for 30 days, so a route's count and p95 need no log search and outlive Workers Logs. `docs/operations.md` describes them and the alerts read from them.
- **Never logged:** bodies, headers, query strings, messages (one exception: a failed dispatcher run and a send review that couldn't size its plan log `cause`, the platform's own message for a Durable Object storage or binding failure or an error of our own, never a database's or AWS's text: `platformMessage` in `api/src/core.ts`), addresses, tokens, keys, or any object but a plain one. `log` rebuilds every value itself (arrays by index up to 50 elements, objects from their own data properties up to 50 keys) and never calls a method, getter or `toJSON` of what it logs; an error, class instance, accessor, proxy that throws or anything nested deeper than three levels becomes `"[object]"`. It reads every error property once, as a primitive, and never throws: a line it cannot build is written as `{"level":"error","code":"LOG_SERIALIZE_FAILED"}`. Callers log operations, IDs and codes; `log` also replaces anything shaped like an address or a long hex credential before writing. The acceptance test `request logs: one line per request…` sends addresses, bodies, forged tokens, unsupported keys and a NUL byte that PostgreSQL refuses (SQLSTATE 22021, its message quoting fake frames) and checks none of it reaches a line.
- **Workers Logs retention is short** (about three days on these accounts), which is why the nightly report keeps its own daily aggregates.

To find a request: Workers Logs for `nightmail-dev` or `nightmail-production`, filter `requestId`. Production volume is small (about 8,000 lines a day), well inside the Workers Paid allowance.

## Nightly report and self-improve loop

`api/scripts/nightly-report.ts` reads the last 24 hours of request and error lines from Workers Logs (the Observability telemetry API, both accounts) and the gateway's CloudWatch group, and writes `~/.config/opensend-mx/reports/nightly-<date>.md` and `.json` on Ryan's Mac. Per stage it lists:

- the top failing routes by count and by failure rate, with their error codes;
- error codes not logged in the previous seven days;
- p95 latency regressions of successful requests (25% or more in the table; an issue at 1.5× and 250 ms over at least 20 samples);
- 5xx by deploy SHA (older lines are matched to their Worker version and the deploy run that created it);
- dispatcher, runner and job failures, and webhook delivery failures;
- the gateway's auth failures (`GATEWAY_AUTH_FAILED`, and `GATEWAY_AUTH_UNAVAILABLE` when the API did not answer).

Each window's aggregate is cached under `reports/state/<stage>/`, and the seven-day baseline comes from those files, so the first week builds it. The events API samples long windows instead of paging, so the script checks every page against the exact count and splits the window, down to one second, until it comes back whole. The API also leaves out a few lines its count includes (33 of 6,539 on dev on Nov 12, even in one-second windows), so a window counts as complete at 99.5%. An incomplete window files no issues and is never cached or used as a baseline; the report says so.

**Issues.** With `NIGHTLY_FILE_ISSUES=1` it opens one issue labeled `nightly` per new problem, at most five a night: a route and error code that answered 5xx, a new error code at error level (a new client error only from 50 a day), a p95 regression, or a jump in gateway auth failures. The body starts with a `nightly-fingerprint` comment; a problem with an open issue is only linked from the report, and one whose issue was closed gets a new issue that names the old one. The repository is public, so an issue is built only from values that pass `publicText` in the script: route templates, error codes, SQLSTATEs, stage names and counts. Request IDs stay in the private report; stack frames and log messages are never read, because a multiline database error can put caller text where a frame is expected.

**Self-improve.** Ryan's Mac runs `~/.config/opensend-mx/nightly-report.sh` with cronctl (`bane-nightly-report`, 03:00 America/New_York). It moves the detached checkout `~/dev/bane-nightly-report` to `bane/dev`, refreshes the `cf` work profile's token, runs the report, then starts one OpenCode child session (`anthropic/claude-opus-5-5`, high) under the Nightmail session that set it up. That session takes the top one to three issues filed that night, reproduces each on the isolated local harness (the acceptance suite or the preview stack against a disposable Postgres in Docker, never dev or production), opens a small fix PR to `dev` for each one it reproduces (never merged), comments on the ones it cannot, and appends what it did to the report's `## Self-improve` section.

Run the report by hand from `api/` (read-only unless `NIGHTLY_FILE_ISSUES=1`):

```sh
CLOUDFLARE_API_TOKEN=<Workers Observability read> NIGHTLY_AWS_PROFILE_DEV=bane-dev NIGHTLY_AWS_PROFILE_PRODUCTION=bane-production \
  node --import tsx scripts/nightly-report.ts
```

**Why Workers Logs and not something new:** it already holds every Worker line at no extra cost, it is queryable over the API, and the Node processes write the same shape to CloudWatch. Workers Analytics Engine would give exact per-route counters for longer, but it needs a new binding on the production Worker and cannot take the gateway's or runner's events; Logpush to R2 adds a job, a bucket and a query engine for volumes this small; and Postgres has 25 connections in production to spend on mail, not logs. If traffic grows past what sampled lines can estimate, add an Analytics Engine data point in `logRequest` next to the line.
