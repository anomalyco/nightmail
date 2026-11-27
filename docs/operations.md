# Operations: what each alert means and where to look

Nightmail measures itself once a minute (`api/src/health.ts`) and says when something falls behind: on the
Operator area's **Health** tab (`/operator?view=health`; on a self-hosted installation, the sidebar's Health
page), as Slack cards on `OPERATOR_SLACK_WEBHOOK_URL`, and as JSON for a program. Every threshold is in
`api/src/health-thresholds.ts`, each with why. This page was written from the incidents of 23 November 2026.

## How an alert reaches you

- **Health** shows warnings and critical alerts once their thresholds hold. An alert closes after three quiet
  minutes. Warnings stay on Health; only critical alerts go to Slack.
- **Slack** posts one human line with an Open button. Critical alerts remind at their existing intervals. A
  repeat within an hour of a critical recovery must stay open for 15 minutes before it posts. A warning that
  becomes critical can page immediately if there was no recent critical recovery for that key.
- **Recoveries** post only for incidents that sent an open card and were observed for at least 15 minutes.
  The three quiet minutes and any Slack retry time do not count toward those 15.
- **In a burst** at most six cards go out a minute: opens, recoveries, then reminders. Opens or recoveries
  that do not fit share one summary. Every individual alert is listed on Health.
- **A card Slack refuses** is tried again on the next tick: an open one for as long as the alert lasts, a cleared
  one for 30 minutes (then `HEALTH_ALERT_DROPPED` is logged). That holds for `database-refusing` too.
- **Pull instead of push:** `GET /v1/operator/health` returns the open alerts and everything the tick measured
  (the Health tab reads the same). It takes an operator's session, or an agent key an operator made in Operator,
  UI notes, Agent keys: `curl -sH "Authorization: Bearer $NIGHTMAIL_AGENT_KEY" https://<origin>/v1/operator/health | jq '.alerts'`.
  Two reads of two small tables: asking every minute costs nothing. `stale: true` means the tick itself has not
  finished for three minutes; treat that as an alert.
- **Without Slack** (every self-hosted installation) nothing is posted: the Health page, the route and the logs
  are the whole of it.
- A card carries numbers, queue names, job types, error codes, route templates, campaign and workspace IDs.
  Never a name, an address or a subject.

## What an agent may do

Everything under "An agent checks first" is read-only: the health route, Workers Logs (`nightmail-production`, filter
on `code`; `docs/ci.md`, Request logs) and `SELECT`s on a read-only database session. Report what you find with
the numbers. Do not pause, resume, cancel, requeue, delete or deploy: those are a person's decisions.

## Evidence that is always there

- **Slow requests and 5xx** are logged in full whatever the sampling: a request line with `slow: true` took 2 s
  or more (`event=request slow=true`, with `route`, `durationMs`, `timings`, `workspace`, `requestId`).
- **Per route, without a log search:** `health_minutes` (two hours, by minute) and `health_hours` (30 days, by
  hour) hold count, 5xx, total and slowest ms and a latency histogram per method and route template. Bucket
  bounds in ms: 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, then slower.
  `SELECT hour,key,n,errors,slowest,hist FROM health_hours WHERE kind='route' AND key='POST /v1/campaigns/:id/send' ORDER BY hour DESC LIMIT 24;`
  The same tables count 5xx by error code (`kind='code'`), database errors by SQLSTATE (`sqlstate`) and
  error-level log lines by code (`error`).
- **Each running campaign** logs `CAMPAIGN_MINUTE` once a minute: released, `rate` (measured from its cursor),
  `acceptedRate`, `entitledRate`, `accountRate`, `plannedRate`, `etaSeconds`, accepted, delivered, bounced,
  `feedbackLagSeconds`.
- **The tick** logs `HEALTH_TICK` (ms, statements, open alerts, cards) every minute, and `HEALTH_PROBE_FAILED`
  with the probe's name when one of its five reads fails; that section then shows as unknown, and its alerts
  neither open nor clear.

## Queues

### queue-behind
The oldest routine delivery report reaching 10 minutes for two ticks is a warning; 30 minutes for two ticks is
critical. The priority lane is critical at 1 minute for two ticks. Oldest measures time since enqueue, including
retry backoff; one old message alone does not mean consumers have stopped. A deep queue that drains in time is only busy and never alerts. The `work` and
`webhooks` queues never alert at all: they carry wake hints for the jobs table, not work, and a burst's hints
stay queued for hours while the jobs themselves are processed (24 Nov: 40,100 hints, the oldest six hours old,
with mailbox.ingest draining). They are on the Health page as "wake hints"; whether work waits is `jobs-behind`.
Bounces and complaints use the priority lane so list probes and auto-pause do not wait behind routine delivery,
open and click reports. The 23 Nov routine backlog (158,000 waiting, 20 minutes behind) would now warn on Health.

**An agent checks first**
1. `GET /v1/operator/health`: `queues[]` (depth and oldest, minute by minute: growing or draining?), `feedbackLagSeconds`, and whether `jobs-behind` or `database-*` is open too.
2. Workers Logs, `code = FEEDBACK_BATCH`, last 15 minutes: compare `lane`, `size`, `oldestMs`, `freshOldestMs` (when present), `failed` and `quarantined`. Old retry timestamps can coexist with prompt first deliveries.
3. Workers Logs, `level = error`, last 15 minutes, grouped by `code`.

**Then** see what is producing: a large campaign (`campaigns[]` on the Health tab) fills the feedback queue at its send rate. If the consumers are healthy but outpaced, slow the campaign (its pacing) rather than wait. `docs/dispatch-scaling.md` has the measured ceilings.

### dead-letters
A dead-letter queue holds a message: normal processing exhausted its retries. Critical on the first one because the event needs recovery.

**An agent checks first**
1. `GET /v1/operator/health`: which queue and how many.
2. Workers Logs, `code = FEEDBACK_BATCH` with `lane` ending `-dlq`, and `SES_FEEDBACK_QUARANTINED`.
3. `SELECT count(*), min(created_at) FROM operation_feedback_quarantine;` (what was set aside for review).

**Then** `api/scripts/replay-feedback-quarantine.ts` replays what was quarantined once the cause is fixed.

## Jobs

### jobs-behind
Due inbound jobs warn at 3 min and page at 10; feedback warns at 10 and pages at 30; campaigns warn at 5
and page at 10. Publishing (5 min), other jobs (10 min) and webhook posts (15 min) warn only. This is the jobs table itself, not the wake messages in the `work`
queue. (23 Nov: 1,883 `mailbox.ingest` jobs 13 minutes late.)

**An agent checks first**
1. `GET /v1/operator/health`: `jobs[]` for the type (`pending`, `oldestSeconds`) and its neighbours: one type behind is a slow handler; every type behind is the runner or the database.
2. `SELECT type,status,count(*),min(available_at) FROM jobs WHERE status IN ('pending','running') AND available_at<=now() GROUP BY 1,2 ORDER BY 3 DESC;`
3. Workers Logs, `code = JOB_DRAIN`: `processed`, `peakActiveJobs`, `durationMs`; and `code = JOB_COMPLETED` with `operation = <type>` (slow ones are always kept): `jobMs`, `claimMs`.

**Then** inbound mail: `docs/receiving-operations.md`. A campaign type behind: see campaign-slow.

### jobs-failed
Jobs of one type that failed in the last hour: 25 or more, or 5 within half an hour (a campaign job, or a job
whose error is `MAILBOX_STAGING_UNDELIVERED`: the first one). It counts by when each job failed (a failed job's
`available_at`), never the failed jobs still kept: those stay 30 days and are on the Health page as "failed in
30 days", for information. So it clears once the last failure is an hour old, and reminds once a day while jobs
keep failing. Webhook posts are left out: a customer's endpoint being down is on the customer's page.
(23 Nov: 1,639 `mailbox.recoverStaging` failed since the 11th, unnoticed; fixed by #625. Those rows are history
and open nothing. A trickle under 25 an hour and 5 a half hour of an ordinary type opens nothing either.)

**An agent checks first**
1. `SELECT last_error,count(*) FILTER (WHERE available_at>now()-interval '1 hour') AS last_hour,count(*) AS kept,max(available_at) AS last_failed FROM jobs WHERE status='failed' AND type='<type>' GROUP BY 1 ORDER BY 2 DESC,3 DESC;`
2. One row, without its payload's content: `SELECT id,workspace_id,attempts,last_error,created_at,available_at FROM jobs WHERE status='failed' AND type='<type>' ORDER BY created_at DESC LIMIT 5;`
3. Workers Logs for one of those `jobId`s: the `logError` line has the error class, SQLSTATE and Nightmail's own stack frames.

**Then** a person decides: fix and requeue, or delete what can never succeed. Do neither from an alert.

## Campaigns

A campaign's `rate` is what happened: recipients released per second, from its own cursor (`expanded`: everyone
released or skipped so far), a minute apart. It is held against what the campaign is `entitled` to: the provider
account's send rate, times the share a workspace of its kind gets (a quarter on the shared pool, all of it for an
exempt first-party workspace or its own account), then the smaller of the campaign's own rate share and an even
split with the workspace's other releasing campaigns. The rate the release planner reads (`planned`) is shown
beside them and no rule uses it: on 23 November it was the number that was wrong. An alert about a rate always
means "slower than it is entitled to": a campaign that is slow because its owner chose a rate share or a daily
pace, because it is scheduled, or because its list probe is waiting, is never one. Its time left is on the page.

### campaign-slow
A sending campaign that is not waiting for anything released under half of what it is entitled to for ten
minutes, or nothing at all for five (warning) or ten (critical). The planner, the dispatcher or the provider is holding it back.

**An agent checks first**
1. `GET /v1/operator/health`: the campaign's `rate`, `acceptedRate`, `entitled`, `account`, `planned`. `planned` far below `entitled`: the planner's view (`regional_workspace_limits`) is the cause. `rate` at `planned` but `acceptedRate` lower: the dispatcher or the provider.
2. Workers Logs, `code = CAMPAIGN_RELEASED` for the `campaignId`: `released`, `capacity`, `buffered`, `rate`. A full buffer means mail is released but not leaving.
3. Is `dispatcher-failing`, `jobs-behind:campaign.*` or `database-*` open? Workers Logs, `code = DISPATCH_BATCH` for the region.

**Then** `docs/dispatch-scaling.md`; an operator can raise a workspace's share (`api/scripts/set-workspace-exemption.ts`).

### campaign-long
At its measured rate a campaign needs more than six hours, and it is releasing under 80% of what it is entitled
to. This is the number nobody had on the 23rd (a 1.8M send at 32 a second of 160: 15 hours, not 3). Health shows
the rate, the account's, what it is entitled to and what the planner reads. A large send at its entitled rate is
not an alert.

**An agent checks first**
1. `GET /v1/operator/health`: `etaSeconds`, `rate`, `entitled`, `account`, `planned` for the campaign.
2. Why is it below what it is entitled to? `planned` under `entitled`: the planner's view. Otherwise see campaign-slow.
3. `SELECT max_send_rate,max_24_hour_send,sent_last_24_hours FROM provider_account_limits;` against the list's size: does the day's quota cover it?

### campaign-preparing
A campaign has been preparing for over five minutes since launch. (23 Nov: 6.5 minutes for 1.8M recipients,
after a 45-second "Send now".)

**An agent checks first**
1. `GET /v1/operator/health`: `campaigns[]` (state, how many are ready), and `jobs[]` for `campaign.prepare` and `campaign.run`.
2. Workers Logs, `code = CAMPAIGN_PREPARE_TIMINGS` for the `campaignId`: `rows` and `durationMs` per slice; is the cursor moving?
3. `slow-requests` for `POST /v1/campaigns/:id/send`, and `SELECT state,prepared,total,updated_at FROM sending_campaigns WHERE id='<id>';`

### campaign-waiting
A sending campaign has waited on a quota, the balance or a hold for fifteen minutes (a list probe: thirty; its
own daily pace: never an alert).

**An agent checks first**
1. `GET /v1/operator/health`: the campaign's `waiting` reason.
2. `SELECT waiting_reason,waiting_until,expanded,total FROM sending_campaigns WHERE id='<id>';`
3. `hosted_daily_quota` or `ses_daily_quota`: `SELECT * FROM provider_account_limits;` (sent against the day's limit). `balance`: the workspace's billing in Operator.

**Then** `docs/sending-limits.md`.

### link-domain-held
Glass → Deliverability shows the registered domain, the latest Spamhaus DBL result and when it was checked.
Marketing releases using that domain wait; existing unsubscribe links still work. Investigate the source before resuming.
After a clear check, a signed-in operator can POST `{"reason":"…"}` (at least ten characters) to
`/v1/operator/glass/link-domains/{domain}/resume`. The audit records who resumed it and why.

### campaign-paused
Nightmail paused a campaign (a quarantine after its list probe, an auto-pause on bounces or complaints, a
failure), not its owner. Open until it is resumed or canceled, or for a day.

**An agent checks first**
1. The Health alert's code (`LIST_QUALITY`, `CONTENT_REJECTED_SPAM`, …) and `/operator/workspaces/<workspace>`: standing, score, quarantines.
2. `SELECT pause_reason,quarantines,expanded,total FROM sending_campaigns WHERE id='<id>';`
3. Workers Logs, `code = CAMPAIGN_AUTO_PAUSED` for the `campaignId`.

**Then** releasing a quarantine is an operator's audited action in the Operator area (`docs/rules.md`).

### campaign-bounces
On mail that has settled (delivered + bounced, at least 1,000) a campaign's bounces reached 5% or its
complaints 0.1%: the lines Amazon's own review starts at. Measured on settled mail because the rate on
everything sent reads low while feedback is late.

**An agent checks first**
1. `GET /v1/operator/health`: the campaign's `settled` and `bounceRate`, and `feedbackLagSeconds`.
2. The workspace's standing in `/operator/workspaces/<workspace>`: did auto-pause or the ladder already act?
3. `SELECT stats->'computedAt', stats->'groups' FROM sending_campaigns WHERE id='<id>';` (how fresh the counts are).

## Requests

### request-storm
One read route, or one workspace's reads, at 1,200 a minute (20 a second) for three minutes. Sending mail is
not a storm. (23 Nov: one finished campaign page asked for `/stats` 50 times a second for hours.)

**An agent checks first**
1. `GET /v1/operator/health`: `routes[]` (count, p95) and the alert's route or workspace.
2. `SELECT minute,key,n FROM health_minutes WHERE kind IN ('route','read') AND n>=1200 ORDER BY minute DESC LIMIT 20;` (since when, and which workspace).
3. Workers Logs, `event = request`, that `route`: `principal` (a dashboard session is a page polling; an API key is a customer's script) and `workspace`.

**Then** a dashboard page: find the query that refetches (see #606). A customer's script: their key's rate limit, and tell them.

### slow-requests
A route had a request over 30 seconds in the last five minutes, or a p95 over 5 seconds across 20 requests.

**An agent checks first**
1. Workers Logs, `event = request`, `slow = true`, that `route`: `durationMs` and `timings` (which step took the time), `workspace`, `requestId`.
2. Then that `requestId`: every line of the request.
3. `GET /v1/operator/health`: is the database behind (`database`, `database-*` alerts)? One slow route with a healthy database is that route's query.

### server-errors
5xx responses in five minutes: ten and 2% of all requests, or fifty.

**An agent checks first**
1. `GET /v1/operator/health`: `errors[]` (which code, which SQLSTATE) and `requests`.
2. Workers Logs, `event = request`, `status >= 500`, grouped by `route` and `code`; then one `requestId` for its `logError` line (error class, SQLSTATE, stack).
3. `DATABASE_UNAVAILABLE` is the database refusing or timing out: see database-errors. `INTERNAL_ERROR` is a bug: which deploy (`deploy` on the line)?

### errors
Error-level log lines of one code, five in five minutes (request lines are counted under server-errors).
`MAILBOX_STAGING_UNDELIVERED` alerts at its first line, critical (and as a failed job's error, at the first
job): mail arrived for a real workspace and its arrival notice was lost, so nobody would otherwise know (#625).

**An agent checks first**
1. Workers Logs, `code = <CODE>`, last 15 minutes: `service`, `operation`, `jobId` or `campaignId`, `databaseCode`, `stack`.
2. `grep -rn "<CODE>" api/src`: what logs it and what it does next (retry, give up).
3. Did it start with a deploy (`deploy` changes on the lines)?

### dispatcher-failing
A dispatcher shard's runs failed three times in fifteen minutes (`DISPATCHER_RUN_FAILED` and its kin). One
failure heals itself: the shard runs again 15 seconds later, and mail it had leased is taken back within three
minutes. The count spans shards and does not prove a send stopped; it is a Health warning. A campaign stalled for ten minutes pages. (23 Nov: 11 in two hours on one shard, at the write of its
pacing state to Durable Object storage.)

**An agent checks first**
1. Workers Logs, `code = DISPATCHER_RUN_FAILED`: `shard` (one or all?), `cause` (the platform's own message, new with this alert), `errorType`, `databaseCode`, `stack`.
2. `GET /v1/operator/health`: is a campaign slow or stalled, is the database refusing?
3. `SELECT status,count(*),min(created_at) FROM sending_emails WHERE status IN ('queued','attempting') AND created_at>now()-interval '1 hour' GROUP BY 1;` (is mail still leaving).

**Then** a storage error on one shard clears with the object's next reset; a database code is the database's.

## Database

### database-refusing
The health tick's own first write was refused or the database could not be reached: read-only (`25006`, a
managed cluster whose disk is nearly full), disk full (`53100`), too many connections (`53300`), or
unreachable. This card needs no database, so it is the one that arrives when nothing else can. (23 Nov: 3.5
minutes read-only.)

**An agent checks first**
1. The card's SQLSTATE. `25006`/`53100`: the disk (PlanetScale's console; #586's disk card). `53300`: connections. Unreachable: the provider's status page and Hyperdrive.
2. `GET /health` (the Worker answers without the database) and `GET /v1/operator/health` (`stale`, last `generatedAt`).
3. Workers Logs, `code = HEALTH_DATABASE_REFUSING`: `databaseCode`, `forSeconds`.

**Then** nothing is lost: requests answered a retryable 503, jobs retry. Free disk (retention, `api/README.md`) or grow it.

### database-errors
Database errors by SQLSTATE in five minutes, from requests and jobs: read-only or disk full at the first one;
too many connections (`53300`) at 3; statement timeouts (`57014`) and deadlocks (`40P01`) at 5; lock timeouts
(`55P03`) at 10.

**An agent checks first**
1. Workers Logs, `databaseCode = <code>`: which `route` or `operation` (one statement or everything?).
2. `SELECT pid,state,wait_event_type,now()-query_start AS running,left(query,120) FROM pg_stat_activity WHERE datname=current_database() AND state<>'idle' ORDER BY query_start LIMIT 20;`
3. `40P01`: the server log names both statements; `docs/ci.md`, Deadlock guard, has the lock order rules.

### database-connections
Connections at 80% of `max_connections` for two ticks: a Health warning. Actual refusals (`53300`) page.

**An agent checks first**
1. `SELECT state,count(*) FROM pg_stat_activity WHERE datname=current_database() GROUP BY 1;` (`idle in transaction` is a leak).
2. `SELECT application_name,client_addr,count(*) FROM pg_stat_activity WHERE datname=current_database() GROUP BY 1,2 ORDER BY 3 DESC;`
3. `GET /v1/operator/health`: a request storm or a queue backlog being drained at full concurrency?

### database-transaction
A transaction has been open ten minutes: it holds back vacuum and may hold locks.

**An agent checks first**
1. `SELECT pid,state,now()-xact_start AS open,wait_event_type,left(query,120) FROM pg_stat_activity WHERE xact_start<now()-interval '1 minute' ORDER BY xact_start;`
2. Is it a migration or retention (`RETENTION_*` in Workers Logs), which end on their own, or `idle in transaction`?
3. `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock';` (is anything waiting behind it).

### database-slow-queries
Three or more queries running over 30 seconds, for two ticks.

**An agent checks first**
1. `SELECT pid,now()-query_start AS running,wait_event_type,left(query,160) FROM pg_stat_activity WHERE state='active' AND query_start<now()-interval '30 seconds' ORDER BY query_start;`
2. The same statement many times: a missing index or a storm (`request-storm`). Different ones: the database is starved (I/O, locks).
3. `slow-requests` and `jobs-behind`: who is waiting on them.

### database-lock-waits
Ten or more sessions waiting on a lock, for two ticks.

**An agent checks first**
1. `SELECT blocked.pid,blocking.pid AS blocker,now()-blocking.xact_start AS held,left(blocking.query,120) FROM pg_stat_activity blocked JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) b(pid) ON true JOIN pg_stat_activity blocking ON blocking.pid=b.pid WHERE blocked.wait_event_type='Lock' LIMIT 20;`
2. The blocker: a migration, a long import, or an `idle in transaction` session (see database-transaction).
3. `database-errors:55P03`: are requests already failing on it?

### database-disk
With `DATABASE_DISK_GB` set: 75% of disk is a warning; 90% is critical. PlanetScale makes the cluster read-only near
95%. Its own webhook (#586) is the finer alert; this one needs nothing from outside.

**An agent checks first**
1. `SELECT relname,pg_size_pretty(pg_total_relation_size(oid)) FROM pg_class WHERE relkind='r' ORDER BY pg_total_relation_size(oid) DESC LIMIT 10;`
2. Workers Logs, `RETENTION_*`: is retention running and deleting?
3. Growth: `GET /v1/operator/health` `database.sizeBytes` now against an hour ago (the Health tab shows it each minute).

### abuse-alerts-undelivered
An abuse alert (review or high) that should have reached the operators' channel has not: still unposted an hour after it
was stored, refused by Slack on its last try, its job failed for good even after the sweep gave it a new one three
times (error `JOB:<code>`), expired unposted (a day went by while it still needed a look), or posted
but unconfirmed (Slack didn't answer either of its two posts in time: it may be in the channel once, twice or not at
all, so look). A warning; **critical while a high alert is unposted**. The alert is in Operator → Abuse either way.

**An agent checks first**
1. Health: the counts and how many are high.
2. `SELECT band,status,attempts,error,stale_reason,created_at FROM abuse_alerts WHERE created_at>now()-interval '2 days' ORDER BY created_at DESC;`
3. `error` NO_WEBHOOK: neither `ABUSE_SLACK_WEBHOOK_URL` nor `OPERATOR_SLACK_WEBHOOK_URL` is bound. HTTP_4xx: the webhook was
   revoked. TIMEOUT: Slack was slow (status `unconfirmed` after the second). Unposted with no error: the `abuse.alert` jobs (`SELECT status,attempts,last_error FROM jobs WHERE type='abuse.alert' ORDER BY created_at DESC LIMIT 20;`),
   or a burst waiting for its level's hourly limit (3 review, 10 high).

### abuse-monitor-behind
A sign-in, payment, pending link or cluster due for scoring has waited over two hours. Each finding names the stage and the age of its oldest outstanding work. It clears at 90 minutes or when none remains. An idle stage with no new observations is healthy.

**An agent checks first**
1. Check the named stage’s job: `SELECT type,status,available_at,last_error FROM jobs WHERE starts_with(type,'abuse.stage.');`.
2. Compare its `ABUSE_STAGE` duration, `ABUSE_STEP_CUT` reason and (for sign-ins) `ABUSE_SIGNIN_BATCH` time per item. A cut after progress requeues immediately. A sign-in job can advance discovery before folding a row: `signin_scan_block` in `abuse_state` is the next block of this pass; −1 means the indexed queue is draining. A full successful batch doubles its size back toward 16. With no progress the stage waits 30 s, 1, 2, 4, 8, then 15 minutes between tries (`ABUSE_STAGE_BACKOFF`).
3. A database timeout, lost connection or serialization failure backs off the stage; it never marks the source version as failed.

### abuse-sample-held
Three sample runs in a row set no new marks because a database session whose start the app role can't see (another role) held the write lock on `sending_email_events`, or the check of open writers failed. While that lasts, workspaces with nothing to sample are read again every run (the cost #1007 removed). No mail is skipped. It clears by itself on the next run that sets marks.

**An agent checks first**
1. Workers Logs: `ABUSE_SAMPLE_MARKS_HELD` gives `reason` (`hidden`: a hidden session holds the lock; `unreadable`: the check failed; `missing`: no table), `writers` and `hidden`.
2. As a role that can see every session: `SELECT a.usename,a.backend_type,a.xact_start,a.state FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE l.relation='sending_email_events'::regclass AND l.mode='RowExclusiveLock';` Expected: none from another role. Autovacuum takes a weaker lock and never holds marks.

### abuse-item-failing
An item could not be folded, grouped or scored because of its data. Health shows the current count and age since the first failure separately for each kind, even before the stage-lag threshold. If scoring or grouping fails, no new alert can be raised for that work until it succeeds.

Inspect the SQLSTATE or validation class, attempt count and due time: `SELECT stage,failures,reason,first_failed_at,retry_after FROM abuse_work_versions WHERE failures>0 ORDER BY retry_after;` This table may retain historical versions; Health counts only current outstanding ones. A failed item becomes due after 15 minutes, then 30, then every hour. Under contention the oldest due retries share 32 reusable permits per stage (16 each for grouping and scoring), each usable once per 15 minutes. New work needs no permit. No manual reset or new sign-in is needed.

### support-ai-cost
The support AI's model calls cost more than `SUPPORT_AI.dailyLineUsd` (`api/src/health-thresholds.ts`) since midnight UTC.
A warning: nothing stops answering (the support platform's daily turn caps, `support/src/limits.ts`, do that). The
operators' Slack gets one card that UTC day; the alert clears when the day ends.

**An agent checks first**
1. Glass → Support AI: today against the 7 and 30 days, and the conversations that cost the most.
2. `SELECT conversation_id,agent,sum(turns),sum(cost_usd) FROM support_ai_usage WHERE at>=date_trunc('day',now(),'UTC') GROUP BY 1,2 ORDER BY 4 DESC LIMIT 10;`
3. One conversation or many: one is a long chat or a loop (its transcript in Support); many is traffic.

## What the tick costs, and what it can never cost

Nothing waits for health. The counters are written after a response, a queue batch or a dispatcher run has
finished (`waitUntil`), and the tick runs beside the minute cron's own steps once dispatch recovery has run,
each on a connection of its own. Every statement they run, reads and writes alike, is in a short transaction
with `lock_timeout` 1 s and `statement_timeout` 3 s; one that cannot get its lock or runs out is dropped, not
retried: a flush loses 20 seconds of counts, a probe's section shows as unknown for a minute, a tick is skipped
(`HEALTH_COUNTERS_DROPPED`, `HEALTH_PROBE_FAILED`, `HEALTH_TICK_SKIPPED`, `HEALTH_TICK_FAILED` in the logs, and
`stale: true` on the route after three minutes). A health table locked for 30 seconds changes nothing else.

One tick is at most 35 statements: the claim, five reads, the rollup with the alerts' read and write, and one
transaction to mark what was posted, each wrapped in `BEGIN`, the limits and `COMMIT`. Each read is bounded by an
index and a `LIMIT` (5,000 jobs a class, 5,000 failed jobs, 200 campaigns) or by a small table; none touches
`sending_emails` or `sending_email_events`. Pull request #628 has the timings measured on a 2-million-row database.

## What to set at deploy

Nothing new is required. The cards go to `OPERATOR_SLACK_WEBHOOK_URL`, the secret production already binds for
the operator alerts; without it (every self-hosted installation) nothing is posted and nothing is called.
Optional: `DATABASE_DISK_GB` (the Health page shows the database against it, and `database-disk` opens at 75%).
For an agent to pull: an operator makes an agent key (Operator, UI notes, Agent keys). Migration 440 creates four
small tables and one small index and takes milliseconds. The failed `mailbox.recoverStaging` jobs of 11 to 23
November open nothing: `jobs-failed` counts the last hour's failures only.

## What is not covered yet

- Feedback lag is the age of the oldest queued message and the oldest due feedback job. #619's
  `operation_feedback_lag` measures event time to applied; when it lands, `feedbackLagSeconds` should read it.
- A campaign's accepted, delivered and bounced counts are its stored counts (`sending_campaigns.stats`), which a
  background job refreshes. #594's tallies make them current to the minute; until then `acceptedRate` and
  `campaign-bounces` lag by that job's interval. The release rate is exact either way.
- The hosted MCP server has no health tool: operator routes are never MCP tools, and an MCP sign-in carries no
  proof of a staff sign-in the way a dashboard session does. An agent reads the route with an agent key.

### SES capacity

Health checks each ready hosted sending region independently. Request quota increases in the affected region.
Tenants and configuration sets warn at 70% and become critical at 85%; identities warn at 60% and become
critical at 80%. CloudWatch is sampled every 15 minutes. If it supplies usage but not a quota, the finding
labels the repository limit (10,000 per resource per region). “Could not be read” retains the last AWS
observation and shows Nightmail’s own count separately; it does not resolve an AWS capacity finding.
Check the daily `SES_QUOTA_SOURCES` log for the source actually available to the runtime. Each failed
CloudWatch attempt logs `SES_QUOTA_READ_FAILED` with the region, batch and cause. A failed batch is tried
once without quota expressions. The whole SES section of a Health tick has a 500 ms budget; if it expires
or stored readings are malformed, Health keeps the previous SES state and logs `SES_HEALTH_UNREADABLE` on opening.

Daily recipients warn at 70% and become critical at 85% of the rolling 24-hour limit. Check the dispatcher’s
quota sample (at most ten minutes old). Sending rate warns after ten completed minutes at 80%; at 95% it
only pages if at least five of those minutes had an SES rate throttle or a transactional pacing deferral
more than five seconds after its dispatch attempt started. Pause or spread large
campaigns while requesting more capacity. Runnable setup work waiting two/five minutes with contention
warns/pages: check setup retries, then pace sign-ups. Setup API speed is fixed. If Ohio has more open and held
sign-up places than remaining tenants, raise the regional tenant quota or lower the sign-up limit.
