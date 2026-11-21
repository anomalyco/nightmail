# Nightmail support (the AI support agent's backend)

A Cloudflare Worker per stage, beside Nightmail in the same account:

| Stage | Worker | URL | Account | Binds |
| --- | --- | --- | --- | --- |
| dev | `bane-support-dev` | `https://support.dev.bane.mx` | anomaly-dev | `bane-dev` |
| production | `bane-support` | `https://support.bane.mx` | anomaly-production | `bane-production` |

Each conversation (a chat from the dashboard's Help panel, or an email thread at the support address) is one `SupportConversation` Durable Object. The agent inside it is **OpenCode**, embedded with `@opencode/sdk/workerd`. The panel talks to it over the WebSocket protocol in [PROTOCOL.md](PROTOCOL.md). How it writes is in [VOICE.md](VOICE.md), and what it knows and may do is in [src/agent/system.md](src/agent/system.md). The design is in the Nightmail plans (`support-agent-design.md`).

## How it fits together

```
dashboard Help ─ POST /v1/contact-support (Nightmail) ─▶ handoff JWS
              ─ POST /chat/start {handoff} ─▶ router ─ BANE.verifyHandoff ─▶ Nightmail SupportPlatform (service binding)
                                                     └ DO.openChat ─ BANE.registerConversation ─▶ Nightmail binds the person; OpenCode boots in the background
              ═ WebSocket /c/<conv>?token= ═▶ DO ─ OpenCode turn ─ tools ─ BANE.request(conv, /v1/support/*)
                                                                └ model ─▶ Console gateway (Opus 5.5, medium)
support@ mail ─ Nightmail route → webhook rule ───▶ POST /hooks/bane-inbound ─▶ DO inbox + alarm
                                              DO ─ BANE_API (address API key) ─ read message, reply in thread
Nightmail ─ POST /hooks/nightmail-wake { conversationId } ─▶ DO.wake: pulls its staff replies
tickets ─ D1 (typed: billing, bug, deliverability, account, abuse_report, feature_request, other)
        ─ email "[Nightmail <type>] tkt_…" to the team (Nightmail API) + the customer's follow-up thread
        ─ staff work them in Nightmail's Support inbox
screenshots ─ POST /c/<conv>/attachments (chat) or email image attachments ─ checked + stripped ─ R2 UPLOADS
            ─ shown to the model as images ─ linked from tickets (7-day signed links)
```

- **Nightmail access** is a service binding to Nightmail's `SupportPlatform` entrypoint (`api/src/support-platform.ts`), with no token. It can verify a handoff, register and close a conversation, and make `/v1/support/*` requests stamped with a chat (`request(conversationId, …)`): Nightmail derives the person from the conversation it registered, on every request, so access never expires mid-conversation and ends when they leave a workspace. The DO takes the conversation ID only from its own storage, and checks it is the object named for it; no tool argument, model output, frame or header can name a person, conversation or token. Each chat turn starts with `GET /v1/support/scope` (`<customer>`) and, for a member with a workspace in scope, `GET /v1/support/context` (`<account>`, kept 5 minutes, dropped when the scope changes), then `GET /v1/support/notes` (`<notes>`: what support noted about this person in earlier chats, the newest 20 within 4,000 characters, only those of workspaces they still belong to, each its date, workspace and escaped text). A chat member's `add_note` tool posts only `{ text }`: Nightmail keeps it for the conversation's person, tagged with its workspace, and the customer never sees it. Email never reads or writes notes. Less access than the last turn ran with (a workspace, a role, content access, the chat's own workspace) ends the chat and retires its model session; a panel joining checks the same. An email conversation reads only once Nightmail bound it to its sender's account, and then only reads (below). Everything the model reads passes `src/agent/projection.ts`, which removes people's and actors' account IDs and the conversation's own IDs. Opening a chat records an `opening` item, with the alarm armed, before Nightmail registers it, so an interrupted opening is closed; closing is a work item, retried until Nightmail confirms it. A conversation opened before the stamp never reads again: its next email goes to a fresh conversation, its unsent answers are held for the team, and it closes.
- **Proposed changes (chat only):** an owner's or admin's chat turns also offer `propose_action` (retry or redeliver webhook mail, test a webhook, pause a campaign; stamped `POST /v1/support/actions?workspaceId=<the chat's workspace>` with only the kind and its IDs) and `recheck_domain` (`POST /v1/support/domains/{id}/verify?workspaceId=…`, no confirmation). Each call reads the scope again first (a refusal or any reduction ends the chat). Nightmail writes each proposal and runs it only on the person's own signed-in decision on the panel's card (`action.request`); the model hears only the kind's fixed title, the status and the ID. The object keeps only IDs: a joining panel's cards and every outcome are read again through the stamp (`GET /v1/support/actions/{id}`), the panel's `action.resolved` hints are paced (one read per proposal every few seconds, Retry-After honoured), and outcomes reach the agent in fixed words (a done retry was queued; an unknown outcome may have arrived). Nothing in this Worker confirms, a typed "yes" changes nothing, an answer that links to a proposal is held, and email never proposes anything.
- **Email and tickets** go through Nightmail's public API as a normal customer would: an API key limited to the support address (`BANE_SUPPORT_INBOX_KEY`) over the `BANE_API` binding.
- **The model** is pinned to Claude Opus 5.5 at medium effort, through Console's inference gateway (`GATEWAY_URL`, key `CONSOLE_GATEWAY_KEY`). It's pinned in the config, the agent, the session and a provider policy. A fetch guard also refuses any other model or effort. Nothing falls back. A conversation whose session began under an earlier pin is switched to the current one before its next turn. The key may only use the models Console's Controls allow for it (Anomaly's workspace, policy "Bane Support"): a model it isn't allowed answers `403 Model access is disabled`. The same fetch caches the tools and the system prompt for an hour (`cache_control.ttl`), so a chat opened after a quiet spell doesn't prefill them again.
- **Opening a chat** costs no model call. The panel shows its own first line ("Hey, what's up? How can we help?") and takes messages at once. On a new page that line is all it shows: an earlier conversation opens only from **Continue last conversation** in its menu; `/chat/start` returns once Nightmail registered the conversation, and OpenCode boots in the Durable Object in the background, ready for the first message. Our tables are named `_support_*` because OpenCode bootstraps its schema only into a database whose other tables start with `_`; a conversation from before is renamed on its next wake.

## Why OpenCode, embedded this way

Ryan's decision was to use the OpenCode harness, a custom agent plus custom tools, rather than a hand-rolled loop. `@opencode/sdk` 2.2.7 ships a **workerd profile** (`@opencode/sdk/workerd`) that boots OpenCode's full application graph inside a Durable Object. It keeps its database on the DO's SQLite and stubs out the filesystem, the shell and the pty. Console's own agents run on the same SDK.

So the agent loop, history, streaming, retries and eviction recovery are OpenCode's. We supply only these:

- one `support` agent (system prompt = `system.md` + `VOICE.md`, 25 steps);
- our tools as a Promise plugin (`src/agent/opencode.ts`, `src/agent/tools.ts`), native rather than Code Mode;
- session permissions that deny `*` and allow only this turn's tools (`toolNames` in `tools.ts`: a chat's by role, an email's `reply` and `file_ticket`), updated on the session when the set changes. The agent-level list alone leaks the built-in `skill` tool;
- a `fetch` that adds the gateway key and enforces the model pin;
- title, summary and compaction turned off, so there are no extra or smaller-model calls.

The DO talks to OpenCode only through `src/agent/harness.ts` (run a turn, report its tool steps, return its text and usage; a chat answer reaches the panel only after the output gate has checked it). **To upgrade**, bump `@opencode/sdk` and `@opencode/plugin` together, run `bun run test`, and check the event names in `opencode.ts` if it fails. The other options were weaker:

- the `packages/llm` / AI SDK route keeps no OpenCode agent or tool model;
- a container would bring a cold start and a sandbox we don't need.

The bundle is 16 MB raw and 2.9 MB gzipped, against a 10 MB limit. In Miniflare a cold boot takes about 0.5 s, and a new conversation in a warm isolate about 12 ms.

## One-time setup (per stage)

Run these from `support/` with the stage's Cloudflare account. Ryan's work profile is `wwrangler`; use `--config wrangler.prod.jsonc` for production.

1. **D1:** run `wrangler d1 create bane-support-dev` (production: `bane-support`), put the id in `wrangler.<stage>.jsonc`, then `bun run migrate:dev` (production: `migrate:production`).
2. **Uploads bucket:** create `bane-support-dev-uploads` (production: `bane-support-uploads`) with a 90-day lifecycle rule, which matches transcript retention: `wrangler r2 bucket create <name>`, then add a rule with `wrangler r2 bucket lifecycle add` that deletes objects after 90 days. The Images binding (`IMAGES`) downscales screenshots over 1.4 MB before the model sees them. It needs no setup beyond Images being enabled on the account.
3. **DNS:** nothing to add by hand. The Worker's Custom Domain (`support.dev.bane.mx` / `support.bane.mx`) creates its record on first deploy, as long as the zone `bane.mx` is in the same account.
4. **The support address** in Nightmail's platform workspace (production `ws_90b0…`, or dev's own), through Nightmail's API with an admin key:
   - create the inbound address `support@bane.mx` (dev: `support@dev.bane.mx`) and put its ID (`mbx_…`) in `SUPPORT_ADDRESS_ID`. Give it the key `support`: routes name an inbox by its address's key;
   - create an API key limited to that address, read and reply (`POST /v1/api-keys` with `access: {"type":"addresses","addressIds":["mbx_…"],"mail":["read","send"]}`): this is `BANE_SUPPORT_INBOX_KEY`;
   - create a webhook (Nightmail format, `include: ["message"]`) to `https://support.bane.mx/hooks/bane-inbound` (dev: `support.dev.bane.mx`). Its `whsec_…` is `BANE_INBOUND_WEBHOOK_SECRET`;
   - add a route for the address to `["inbox:support", "webhook:<that webhook>"]`. Keep the root catch-all at `store`.
5. **The intake addresses** `abuse@`, `privacy@` and `legal@bane.mx` (dev: `@dev.bane.mx`), in the same platform workspace. These go straight to typed tickets and never reach the agent (`src/intake.ts`). A ticket names only the sender address and its DMARC verdict, never an account:
   - create the three inbound addresses, and one API key limited to those three, read and reply. This is `BANE_INTAKE_INBOX_KEY`;
   - create a second webhook (Nightmail format, `include: ["message"]`) to `https://support.bane.mx/hooks/bane-intake`. Its `whsec_…` is `BANE_INTAKE_WEBHOOK_SECRET`;
   - add a route for each address to its own inbox and the shared webhook, such as `abuse@bane.mx` → `["inbox:abuse", "webhook:<that webhook>"]` (an inbox is per address, so there's no single `inbox:intake`). The team reads full messages and non-image attachments in those inboxes;
   - `INTAKE_ADDRESSES` in the wrangler config lists them.
6. **Secrets**, set with `wrangler secret put <NAME> --config wrangler.<stage>.jsonc` and never through CI:
   - `CONSOLE_GATEWAY_KEY`: the Console service key (`models:request`, budgeted). Without it, chat turns refuse with "isn't fully set up" and emails wait in the inbox.
   - `SUPPORT_ROOT_SECRET`: 32+ random bytes as hex (`openssl rand -hex 32`). It's the root for the chat-token and confirm-link keys.
   - `BANE_INBOUND_WEBHOOK_SECRET` and `BANE_SUPPORT_INBOX_KEY`, from step 4.
   - `BANE_INTAKE_WEBHOOK_SECRET` and `BANE_INTAKE_INBOX_KEY`, from step 5.
7. **Deploy.** With `SUPPORT_DEPLOY=true`, CI prepares support alongside Nightmail and waits for this attempt's healthy Nightmail Worker before migrating D1 or deploying support. By hand: `wrangler deploy --config wrangler.<stage>.jsonc`. Deploy Nightmail first: the binding needs Nightmail's `SupportPlatform` entrypoint.
8. **Point the dashboard at it:** set Nightmail's `BANE_SUPPORT_URL` to `https://support.bane.mx/chat` (dev: `support.dev.bane.mx`).

## Develop and test

```sh
bun install
bun run check   # types
bun run test    # builds the real bundle, then drives it in Miniflare with a fake Nightmail and a scripted model
```

The tests run the deployed bundle in Miniflare, as Console's agent tests do. `@cloudflare/vitest-pool-workers` can't load the OpenCode SDK. They cover:

- opening a chat without a model call;
- a tool turn and its projection; every read stamped with its own conversation, whatever a tool argument names, and two conversations never reading each other's account;
- a refund ticket and its emails;
- consent that counts only when Nightmail's scope says so;
- a person removed from the workspace: the next turn ends the conversation without a model call;
- notes: one chat's note reaches the same person's next chat as escaped data without IDs, but not another member's and not after they leave the workspace; email turns (verified ones too) neither offer `add_note` nor get notes;
- the output gate;
- proposed changes in chat: a typed "yes" executes nothing, outcomes are Nightmail's and never a frame's (in fixed words), cards and outcomes re-read after access changes, refusals end the chat, hints paced, no confirm link in any answer, at most 3 open, none of it (or the DNS re-check) for a member or by email;
- the email path, from signature to registration to a general reply with the Help line and no stamped request; a DMARC failure that gets the fixed reply with its own sign-in, no model call, its answer parked;
- verified email: an aligned pass from a member's address answers her account question with her role's reads and no Help line, counted against her and her address; no change, note or content access offered, and a forced call refused; a narrowed scope that gives less mid-turn holds the written answer and sends the notice; the release check holds an answer once the address isn't her verified email or her mailbox proof lapsed; a sign-in releases only its message, once, to her address as the account stores it; a person at the cap of open email conversations gets the busy reply; the email's angle brackets reach the model escaped; one address can't use up the unauthenticated bucket; the sweep reaches a claimed conversation past the first 200 parked; a verified email's ticket names its person, read-only, and a chat ticket's follow-up joins it only from the chat's own person;
- the reply tool: one reply per email (a second call refused), the same text after a crash with no second model call, the sender as the only recipient, the nudge then the busy reply when there is none, an email after an interrupted turn answered by its own reply; email turns offering only `reply` and `file_ticket`, and the email turn cap;
- that the model never sees a person's or actor's account ID, in `<account>` or a tool result;
- failing closed without the gateway key;
- image checks: type by magic bytes, EXIF/XMP/text removed for PNG, JPEG and WebP, damage and oversize refused;
- uploads: chat token, origin, 413, 415 and the 5-image cap. The model receives the stripped bytes;
- a bug ticket: refused without its reproduction, then filed with request IDs from `api_errors`. The `[Nightmail bug]` email carries signed screenshot links, and tampered or expired links are refused;
- email image attachments;
- the work queues, and the ledger and sweep: mail held at the edge for the digest, intake mail for an unlisted address accepted once it's listed, a ticket's lost team email sent once, and a failed digest resent once;
- replay and readiness: mail stored before any route is answered once, a key that gains an address replays its mail, no flow takes another's address, and health reports readiness as counts only.

They make no network or model calls. `test/*.local.ts` scripts, which are git-ignored, are for a few real turns against the gateway with a key read from a file.

## Email: verified senders and general answers

Each email conversation belongs to the first address that writes in it. Nightmail registers every message (`registerConversation` with the message ID) and decides, from evidence it stored itself, whom the message is for (`api/README.md` "Support conversations"). The Worker never decides it from an address.

- **Verified** (`member`): Nightmail bound the conversation to the sender's account, because the message was received at a support address, ingest's author check is set (well-formed header names, one literal From, consistent with the full headers and SES's own From), SES's DMARC verdict is PASS, the From as written is exactly one account's verified email (the local part in the same case), a sign-in proved that address the person's mailbox within the last 30 days, the message was written to support (support in its To or Cc, a Date within days, a Message-ID that never bound that account before) and the account has a workspace. The agent answers the person's own account questions, read-only, by role: the account reads (the owner/admin ones only for an owner or admin in scope), `choose_workspace`, `reply` and `file_ticket`. Never a proposal, a DNS re-check, a note or content access: they aren't offered, the tool host refuses them, and Nightmail refuses an email conversation's notes and actions routes too. For a change, the agent points to Help in the dashboard, where the person confirms it on the card. `<customer>` and `<account>` come from Nightmail's scope (its person by ID, never shown to the model), and every tool result and the prefetch pass the same ID projection as chat. No Help line is added.
- **General** (`non_member`: the sender passed DMARC, but no account binds): the agent's general answer, with only `reply` and `file_ticket`, no stamped request, and "For anything about your account, sign in to Nightmail and press Help" with Nightmail's link added after the gate. A general turn never shares a model session that read an account: such a session is replaced first.
- **Unproven** (`pending_signin`, `unverified`): one fixed reply, the same either way (so it never says whether an account exists), naming when the email arrived (so two of them can be told apart), with a sign-in link for that one message: `<dashboard>/support/continue/<conversation>/<message>`, under a key of its own (`reply-<message>:signin`). No model call. The message's answer waits, parked. The page shows the person which email it is (its subject and when it arrived, never its content), and they confirm it signed in (Nightmail's claim: their session's verified email must be the sender's address, a mailbox they proved, and the sign-in at most 7 days old); that binds an unbound conversation to them and records the sign-in for that message only. The claim wakes this conversation with its ID only; it asks Nightmail's scope, releases exactly the parked answers whose message the scope lists as signed in, once each, and writes each from the account. A claim for one message never releases another, and an address-only confirm link from an earlier release releases nothing. The five-minute sweep wakes conversations with an answer parked for a sign-in too, in case a wake is lost (Work and the sweep). Closing holds what is still parked.
- **Every later message is checked again.** It must come from the same address, and in a bound conversation bind the same account again: anything else (another sender, a spoof of the address, the address now another account's, a closed conversation) goes to a conversation of its own.
- **Every scope is compared before it is installed**: at the start of each verified answer, when `choose_workspace` narrows it, and before the answer is sent. Less than the last turn ran with (a workspace gone, a lower role), or a read refused mid-turn, stops the turn, retires its model session, holds any draft for the team and ends the conversation, with a fixed notice to the sender under a key of its own (`reply-<message>:ended`).
- **The release check**, before every send of a verified answer, retries included: the conversation open here (no close under way) and with Nightmail, its scope no less than the turn ran with and still the same person, and the sender still that person's address, a mailbox they proved within 30 days (`user.mailboxProven`, not a display match). It goes to that address as Nightmail stores it (`user.email`, fixed at the first check), never to the From as it arrived. Otherwise the draft is held, never sent under its key with other text, and the sender gets the fixed notice when access changed. Nightmail unreachable: the send waits and checks again.
- **The answer is the `reply` tool's text.** The model calls it once; the call runs the output gate and freezes the email into the answer's work item, marked `mode: 'general'` (with the Help line) or `mode: 'verified'` (without it). A held reply freezes the fixed held note instead and files one ticket. A second call is refused, nothing the model writes as text is sent, and a retry sends the same email once. A turn that ends without a reply gets one hidden nudge, then the busy reply and a ticket. A turn cut off by an eviction is stopped when OpenCode resumes it, before the next turn starts.
- **Answers an earlier build wrote** (no `mode` marker) are never sent: held as drafts for the team when the object loads, as are answers an earlier build parked. Only a fixed reply, a general answer, or a verified answer that passes the release check is ever sent.
- **Mail at a chat** (a reply in its ticket's follow-up thread) goes to an email conversation of its own for that thread and sender, and never touches the chat, its transcript or its session. It is added to the chat's ticket ("Customer wrote again", and the agent doesn't answer: the team owns that thread) only when that conversation is verified and Nightmail's person for it is the chat's person, compared by ID; anyone else's is answered on its own.
- **Tickets from email** name the person Nightmail bound (from its scope, never an address), headed as verified by email for reading only, never grounds for a change; an unbound conversation's ticket names no customer, only the address that wrote. A chat's ticket names the chat's person.
- **The email's own text** reaches the model inside `<untrusted>` with its `<` and `>` escaped, so it can't close the fence or fake the harness's tags.
- **A person at Nightmail's cap of open email conversations** (10, apart from their chats) gets the fixed busy reply once, and the email is kept for the team's digest.
- **Links in email replies** must point to Nightmail's own sites, or the reply is held.

## Work and the sweep

Each object's work (each email, its answer or forward, each ticket's team email and follow-up, a chat's opening and closing) is an item in its own `_support_work` table (`src/work.ts`), retried until done without blocking the others.

- **The ledger** (D1 `support_work`): a webhook writes a row for each message before it answers 200. Mail refused at the edge gets a row too: `held` (over the per-sender limit) or `blocked` (intake mail for an address missing from `INTAKE_ADDRESSES`). A later delivery of a message with a row changes nothing.
- **The mirror:** at the end of each run, an object copies its changed items into the same table. The cron reads what is waiting there instead of waking every object. Copying is best effort: work never waits on it.
- **The sweep** (every five minutes, `src/ledger.ts`):
  - resends unsent notices (the digest, cap alerts) whose retry is due;
  - accepts blocked intake mail once its address is listed;
  - asks a ticket's object to queue its team email, and a chat ticket's follow-up within a day, when no item covers them (tickets filed before the queue). The email is rebuilt from the D1 row; an existing item is left alone, so each is sent once;
  - pulls the staff inbox's replies from Nightmail and hands each to its conversation (the staff inbox, below);
  - wakes up to 50 conversations whose answer is parked for a sign-in and due for a check (the longest due first), so a sign-in whose wake was lost is still answered. The sweep moves each one's next check later before it wakes it, and the conversation moves it again (5, 10, 20, 40, then every 60 minutes), so every parked answer's turn comes, until it is released or its conversation closes;
  - checks each key and replays missed mail (replay and readiness, below).

## The staff inbox

Nightmail's staff Support inbox (`/support` in the dashboard, `api/src/support-inbox.ts`) shows every conversation registered there. Each object keeps it current over the `BANE` binding:

- **Mirror:** every transcript entry (the customer's messages as they arrive, the agent's answers and tool labels, the harness's notices, held drafts) goes to `mirrorMessages` in order, from a cursor, and the conversation's subject, ticket, turns, cost and blocked work to `mirrorState`. A failed mirror is retried from the same place (1, 2, 5, 15, 30, 60 minutes); a conversation Nightmail hasn't registered waits for its next entry.
- **Pause:** before every chat turn and every email answer the object reads `inboxState`. While staff have paused the agent it records and mirrors the customer's messages but runs no turn: chat shows one notice, an email gets no answer, and an answer already written but not sent stays a held draft in the inbox. Handing back resumes with the next message. An emailed ticket shows as paused for the ticket, as the agent answers no later mail there.
- **Staff replies:** Nightmail queues a staff reply, then POSTs `{ conversationId }` (nothing else) to `/hooks/nightmail-wake` (rate-limited by `WAKE`); that conversation pulls its replies with `pullOutbox` at once, and the five-minute sweep pulls everyone's. A sign-in wakes it the same way, and it then also releases what Nightmail's scope lists as signed in. Each reply is a `staff:` item, delivered once: an email reply in the thread to its last customer message, only to the address whose mail passed DMARC; a chat reply into the transcript and open sockets (`kind: "staff"`, PROTOCOL.md), or by email to the account address when no socket is open. Then `markDelivery` records it sent, or failed when it can't be delivered.

## Replay and readiness

Nightmail records a `message.received` event for every message an address receives, whether or not a route exists, and keeps it 30 days. The sweep reads those events with each flow's own key (`src/replay.ts`), so mail that arrived before its route existed, or whose webhook never came, is still answered once.

- **Key self-check:** each sweep lists the addresses each key reads (`GET /v1/inbound/addresses`) and compares them with the flow's list: `SUPPORT_ADDRESSES` (default `SUPPORT_ADDRESS`) or `INTAKE_ADDRESSES`. The result is `ok`, `missing`, `extra`, `not_configured` (this Worker has no key for the flow: its secret is unset), `unauthorized` (Nightmail refused the key) or `unavailable` (D1 `support_checks`). When a flow's coverage becomes complete again, objects with blocked work are woken, and that work runs at once.
- **Replay:** only addresses that are both listed and readable are polled, up to 50 events per flow per sweep, each from its own cursor (D1 `replay_cursors`). An address the key can't read isn't polled, so its cursor never passes mail it couldn't see; once the key reads it, its mail since the cursor is replayed. Polling starts at the end of the log when first installed. A message with a ledger row is skipped. A message for a thread whose conversation closed more than 7 days ago is kept for the digest instead of reopening it.
- **`GET /health`:** `status` stays `ok` (the deploy reads it as liveness). `ready` and `checks` come from D1 alone, as counts and states, never addresses, IDs or error text; `work.blockedBy` counts blocked items by error code (`MISSING_SECRET`: set the secret; `NOT_FOUND` or `FORBIDDEN`: widen the key or add the route). `ready` means both keys are `ok`, nothing is blocked, nothing has failed six or more times, and the poller caught up within 15 minutes. `routeGaps24h` counts mail the poller found before any webhook did.
- **Changing a key:** expand an existing key's addresses rather than replacing the key: idempotency keys are scoped to the API key, so a replaced key could resend a reply. Replace a key only when health shows nothing blocked. Every move into `blocked` logs `WORK_BLOCKED` at error level.

## Limits and retention

- **Daily caps** (`src/limits.ts`; override each with a `LIMIT_*` var). The budgets are separate, so one can't starve another:
  - model turns: 1,500 a day, 100 per chat person, and 5 per email sender address (`LIMIT_TURNS_PER_EMAIL_SENDER`); a verified email's turn counts against its person's 100 as well;
  - tickets: a 60-a-day reserve for verified customers, 40 a day per intake address for everyone else, and 3 per customer or DMARC-passing sender;
  - mail: 20 a day per DMARC-passing sender, 30 per address for all unauthenticated mail together (a spoofed From can't spread across keys), of which at most 3 per From address at support@ (`LIMIT_MAIL_UNAUTHENTICATED_PER_ADDRESS`, so a forged address can't use up the sign-in replies of every sender without DMARC), and 2,000 in total.

  Mail over a cap is never dropped. It's kept, bounded, in D1 `overflow`, and the daily cron (00:10 UTC) emails the team one "N messages over cap" digest. The first time a global cap is hit each day, the team gets an alert at once. Both emails are frozen when first queued (D1 `support_notices`) and resent by the five-minute sweep, under the same idempotency key, until Nightmail accepts them. The daily cron also runs the retention sweep.
- **Per sender at the edge:** 10 messages a minute (the `EMAIL_IN` limiter). Mail over it is never read or answered, but it's recorded in the work ledger and listed in the digest.
- **Per conversation:** 60 turns, and 500K tokens weighted by cost (cache reads count a tenth). Past either, the conversation files a ticket.
- **Per person:** 10 chats a day.
- **Per email thread:** 5 messages in 10 minutes.
- **Tool steps:** 25 per turn.
- **Retention:** chats close after 24 hours idle, email threads after 7 days. The DO deletes its storage 7 days after closing. D1 keeps the conversation index and tickets, finished ledger rows for 35 days, and notices for 30. Intake mail blocked for 30 days is given up (it stays in Nightmail's inbox).
