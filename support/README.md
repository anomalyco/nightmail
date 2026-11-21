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
Nightmail ─ POST /hooks/nightmail-wake { conversationId } ─▶ DO.wake: reads Nightmail again (a claim, staff replies)
tickets ─ D1 (typed: billing, bug, deliverability, account, abuse_report, feature_request, other)
        ─ email "[Nightmail <type>] tkt_…" to the team (Nightmail API) + the customer's follow-up thread
        ─ staff list at /staff (Nightmail operator sign-in), mark done
screenshots ─ POST /c/<conv>/attachments (chat) or email image attachments ─ checked + stripped ─ R2 UPLOADS
            ─ shown to the model as images ─ linked from tickets (7-day signed links)
```

- **Nightmail access** is a service binding to Nightmail's `SupportPlatform` entrypoint (`api/src/support-platform.ts`), with no token. It can verify a handoff, register and close a conversation, and make `/v1/support/*` requests stamped with a conversation (`request(conversationId, …)`): Nightmail derives the person from the conversation it registered, on every request, so access never expires mid-conversation and ends when they leave a workspace. The DO takes the conversation ID only from its own storage, and checks it is the object named for it; no tool argument, model output, frame or header can name a person, conversation or token. Each turn starts with `GET /v1/support/scope` (`<customer>`) and, for a member with a workspace in scope, `GET /v1/support/context` (`<account>`, kept 5 minutes, dropped when the scope changes). Less access than the last turn ran with (a workspace, a role, content access, a chat's own workspace) ends the conversation and retires its model session; a panel joining and an email answer about to go out check the same. A conversation opened before this never reads again: its next email goes to a fresh conversation, its unsent answers are held for the team, and it closes (its grant in `_support_grant` revoked). Closing is a work item, retried until Nightmail confirms it.
- **Email and tickets** go through Nightmail's public API as a normal customer would: an API key limited to the support address (`BANE_SUPPORT_INBOX_KEY`) over the `BANE_API` binding.
- **The model** is pinned to Claude Opus 5.5 at medium effort, through Console's inference gateway (`GATEWAY_URL`, key `CONSOLE_GATEWAY_KEY`). It's pinned in the config, the agent, the session and a provider policy. A fetch guard also refuses any other model or effort. Nothing falls back. A conversation whose session began under an earlier pin is switched to the current one before its next turn. The key may only use the models Console's Controls allow for it (Anomaly's workspace, policy "Bane Support"): a model it isn't allowed answers `403 Model access is disabled`. The same fetch caches the tools and the system prompt for an hour (`cache_control.ttl`), so a chat opened after a quiet spell doesn't prefill them again.
- **Opening a chat** costs no model call. The panel shows its own first line ("Hey, what's up? How can we help?") and takes messages at once. On a new page that line is all it shows: an earlier conversation opens only from **Continue last conversation** in its menu; `/chat/start` returns once Nightmail registered the conversation, and OpenCode boots in the Durable Object in the background, ready for the first message. Our tables are named `_support_*` because OpenCode bootstraps its schema only into a database whose other tables start with `_`; a conversation from before is renamed on its next wake.

## Why OpenCode, embedded this way

Ryan's decision was to use the OpenCode harness, a custom agent plus custom tools, rather than a hand-rolled loop. `@opencode/sdk` 2.2.7 ships a **workerd profile** (`@opencode/sdk/workerd`) that boots OpenCode's full application graph inside a Durable Object. It keeps its database on the DO's SQLite and stubs out the filesystem, the shell and the pty. Console's own agents run on the same SDK.

So the agent loop, history, streaming, retries and eviction recovery are OpenCode's. We supply only these:

- one `support` agent (system prompt = `system.md` + `VOICE.md`, 25 steps);
- our tools as a Promise plugin (`src/agent/opencode.ts`, `src/agent/tools.ts`), native rather than Code Mode;
- session permissions that deny `*` and allow only our tools. The agent-level list alone leaks the built-in `skill` tool;
- a `fetch` that adds the gateway key and enforces the model pin;
- title, summary and compaction turned off, so there are no extra or smaller-model calls.

The DO talks to OpenCode only through `src/agent/harness.ts` (run a turn, stream events, report usage). **To upgrade**, bump `@opencode/sdk` and `@opencode/plugin` together, run `bun run test`, and check the event names in `opencode.ts` if it fails. The other options were weaker:

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
5. **The intake addresses** `abuse@`, `privacy@` and `legal@bane.mx` (dev: `@dev.bane.mx`), in the same platform workspace. These go straight to typed tickets and never reach the agent (`src/intake.ts`):
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

## Staff ticket page

`https://support.bane.mx/staff` (dev: `support.dev.bane.mx`) lists tickets by type and status. Each ticket shows its details, a bug's reproduction and its screenshots, and can be marked done with a note.

- **Sign-in:** "Sign in with Nightmail" goes to Nightmail's `GET /v1/operator/support/staff-sign-in`. That route needs an operator's dashboard session, then redirects back with a 2-minute signed token.
- **Verification:** this Worker has Nightmail verify the token over the binding (`verifyStaff`), which also confirms the person is still an operator. It uses the token once, then sets an 8-hour, host-only `__Host-` cookie.
- **Writes:** these need the session's CSRF token and a same-origin form post.

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
- the output gate;
- the email path, from signature to registration to reply; a DMARC failure that waits for a sign-in, then is answered once after the claim;
- failing closed without the gateway key;
- image checks: type by magic bytes, EXIF/XMP/text removed for PNG, JPEG and WebP, damage and oversize refused;
- uploads: chat token, origin, 413, 415 and the 5-image cap. The model receives the stripped bytes;
- a bug ticket: refused without its reproduction, then filed with request IDs from `api_errors`. The `[Nightmail bug]` email carries signed screenshot links, and tampered or expired links are refused;
- the staff page: sign-in, single-use token, a demoted operator, filters, CSRF, origin and session checks on "mark done", and the hourly operator re-check;
- email image attachments;
- the work queues, and the ledger and sweep: mail held at the edge for the digest, intake mail for an unlisted address accepted once it's listed, a ticket's lost team email sent once, and a failed digest resent once.

They make no network or model calls. `test/*.local.ts` scripts, which are git-ignored, are for a few real turns against the gateway with a key read from a file.

## Email: who gets a turn

Each email conversation is bound to the first address that writes in it. Nightmail registers every message (`registerConversation` with the message ID) and decides from the message it stored whom the conversation is for: `member`, `non_member`, `pending_signin` or `unverified`.

- **Every later message is checked again.** It must come from that address and still verify as the same person. Anything else (another sender, a message that no longer verifies, a closed conversation) goes to a conversation of its own and never touches the session or its account.
- **Only a member gets a model turn.**
  - `pending_signin` and `unverified` get the same fixed reply, so it never says whether an account exists: sign in to continue (`<Nightmail>/support/continue/<conversation>`), or confirm the address. The answer waits. A claim (the person's own sign-in) wakes this Worker, which reads Nightmail's scope and answers the waiting messages once each; the next email checks again if a wake was lost. A confirmation proves the address only: the waiting messages get the `non_member` reply.
  - `non_member` (no account, or no workspace) gets a fixed reply.
- **Access that ends mid-conversation** (Nightmail's scope says `shrunk`): a fixed reply that the conversation ended, then it closes.
- **Tickets from unverified senders** lead with "UNVERIFIED SENDER" and name no customer.
- **Links in email replies** must point to Nightmail's own sites, or the reply is held.

## Work and the sweep

Each object's work (each email, its answer, confirm link or forward, each ticket's team email and follow-up) is an item in its own `_support_work` table (`src/work.ts`), retried until done without blocking the others.

- **The ledger** (D1 `support_work`): a webhook writes a row for each message before it answers 200. Mail refused at the edge gets a row too: `held` (over the per-sender limit) or `blocked` (intake mail for an address missing from `INTAKE_ADDRESSES`). A later delivery of a message with a row changes nothing.
- **The mirror:** at the end of each run, an object copies its changed items into the same table. The cron reads what is waiting there instead of waking every object. Copying is best effort: work never waits on it.
- **The sweep** (every five minutes, `src/ledger.ts`):
  - resends unsent notices (the digest, cap alerts) whose retry is due;
  - accepts blocked intake mail once its address is listed;
  - asks a ticket's object to queue its team email, and a chat ticket's follow-up within a day, when no item covers them (tickets filed before the queue). The email is rebuilt from the D1 row; an existing item is left alone, so each is sent once;
  - pulls the staff inbox's replies from Nightmail and hands each to its conversation (below).

## The staff inbox

Nightmail's staff Support inbox (`/support` in the dashboard, `api/src/support-inbox.ts`) shows every conversation registered there. Each object keeps it current over the `BANE` binding:

- **Mirror:** every transcript entry (the customer's messages as they arrive, the agent's answers and tool labels, the harness's notices, held drafts) goes to `mirrorMessages` in order, from a cursor, and the conversation's subject, ticket, turns, cost and blocked work to `mirrorState`. A failed mirror is retried from the same place (1, 2, 5, 15, 30, 60 minutes); a conversation Nightmail hasn't registered waits for its next entry.
- **Pause:** before every chat turn and every email answer the object reads `inboxState`. While staff have paused the agent it records and mirrors the customer's messages but runs no turn: chat shows one notice, an email gets no answer, and an answer already written but not sent stays a held draft in the inbox. Handing back resumes with the next message. An emailed ticket shows as paused for the ticket, as the agent answers no later mail there.
- **Staff replies:** Nightmail queues a staff reply, then POSTs `{ conversationId }` (nothing else) to `/hooks/nightmail-wake` (rate-limited by `WAKE`); that conversation pulls its replies with `pullOutbox` at once, and the five-minute sweep pulls everyone's. Each reply is a `staff:` item, delivered once: an email reply in the thread to its last customer message, only to the address whose mail passed DMARC; a chat reply into the transcript and open sockets (`kind: "staff"`, PROTOCOL.md), or by email to the account address when no socket is open. Then `markDelivery` records it sent, or failed when it can't be delivered.

## Limits and retention

- **Daily caps** (`src/limits.ts`; override each with a `LIMIT_*` var). The budgets are separate, so one can't starve another:
  - model turns: 1,500 a day, and 100 per person;
  - tickets: a 60-a-day reserve for verified customers, 40 a day per intake address for everyone else, and 3 per customer or DMARC-passing sender;
  - mail: 20 a day per DMARC-passing sender, 30 per address for all unauthenticated mail together (a spoofed From can't spread across keys), and 2,000 in total;
  - confirm links: 3 per address a day, at most one an hour per open confirmation. Later mail from the address joins the open confirmation and is answered once it's confirmed.

  Mail over a cap is never dropped. It's kept, bounded, in D1 `overflow`, and the daily cron (00:10 UTC) emails the team one "N messages over cap" digest. The first time a global cap is hit each day, the team gets an alert at once. Both emails are frozen when first queued (D1 `support_notices`) and resent by the five-minute sweep, under the same idempotency key, until Nightmail accepts them. The daily cron also runs the retention sweep.
- **Per sender at the edge:** 10 messages a minute (the `EMAIL_IN` limiter). Mail over it is never read or answered, but it's recorded in the work ledger and listed in the digest.
- **Per conversation:** 60 turns, and 500K tokens weighted by cost (cache reads count a tenth). Past either, the conversation files a ticket.
- **Per person:** 10 chats a day.
- **Per email thread:** 5 messages in 10 minutes.
- **Tool steps:** 25 per turn.
- **Retention:** chats close after 24 hours idle, email threads after 7 days. The DO deletes its storage 7 days after closing. D1 keeps the conversation index and tickets, finished ledger rows for 35 days, and notices for 30. Intake mail blocked for 30 days is given up (it stays in Nightmail's inbox).
