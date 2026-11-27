# Nightmail MCP

Connect an MCP client to **`https://YOUR_NIGHTMAIL_DOMAIN/mcp`**. The MCP server is part of the Nightmail API, so no local process is needed. This installation uses **https://nightmail.dev/mcp**.

There are two ways to connect:

| Connect with | It acts as | Set up |
|---|---|---|
| **Sign in as you** (OAuth) | You, in any of your workspaces, with the access you approve (read, send or manage) intersected with your role in each | Add the URL; the client opens your browser to sign in |
| **An API key or agent token** | That credential, in its own workspace, with exactly its permissions | Add the URL with an `Authorization: Bearer …` header; no browser |

An agent without any credential gets its own API key first, from the [setup token in a copied prompt or a device code](#an-agents-own-key-a-setup-token-or-a-device-code), then connects with it as a key.

Keys limited to receiving addresses or one agent inbox (`nm_mbx_…`) connect the same way as other keys. See [Agent inboxes](#agent-inboxes).

If you authorised your client against an earlier address of the service, reconnect it to `https://nightmail.dev/mcp` and approve access again.

## Connect

### Sign in as you

1. Add the HTTPS URL as a remote HTTP MCP server in your client.
2. The client reads Nightmail's protected resource metadata and signs in at the account service it names (Anomaly account for hosted Nightmail). OpenCode identifies itself there with a client metadata document; other clients register.
3. Review the client and the requested access at Anomaly account, then allow it. The client exchanges the authorization code using PKCE and stores its own access token, not your dashboard cookie or ID token. Nothing in Nightmail asks for a workspace: the connection can work in every workspace you belong to.

In OpenCode, run `opencode2 mcp add nightmail --global --url https://YOUR_NIGHTMAIL_DOMAIN/mcp`, then `opencode2 mcp auth nightmail` (or select Nightmail in `/mcps` and sign in). Use the plain URL: OpenCode signs in for the URL you configure and adds `?codemode=false` itself. In Claude Code or Codex, use `https://YOUR_NIGHTMAIL_DOMAIN/mcp?codemode=false` for the remote HTTP server.

### With an API key or agent token

Pass a workspace API key (`nm_…`) or an agent token (`nm_agent_…`) as the bearer token. The connection then acts only in that credential's workspace, with only its permissions and sender domains:

```json
{"$schema":"https://opencode.ai/config.json","mcp":{"servers":{"nightmail":{"type":"remote","url":"https://nightmail.dev/mcp","oauth":false,"headers":{"Authorization":"Bearer {env:NIGHTMAIL_API_KEY}"}}}}}
```

In the dashboard, **API keys → Create key** shows this setup for OpenCode, Claude Code and Cursor right after the key is made. Every tool call is an API request made with that credential: Nightmail checks the key on each call (revoked, expired, its minute budget, an agent token's approval), and the API answers exactly as it would over HTTP. The listing offers what the API allows the credential. A temporary agent token never administers keys, webhooks, rules or routes, and only a signed-in approval mints agent tokens. Tools take no `workspace` argument: naming the key's own workspace is accepted, and any other is refused with `403 WORKSPACE_ACCESS_DENIED`. A key is the right choice for a headless agent or a remote machine where a browser sign-in is awkward. Keep it out of committed configs: reference an environment variable, as above.

### An agent's own key: a setup token or a device code

A coding agent can get its own API key without one made by hand, then connect here with it as above (the response includes that config, reading the key from `NIGHTMAIL_API_KEY`). Prefer the agent prompt: the person copies it where they already are and the agent connects in seconds. A device code waits for the person to open a link the agent shows in its own window, which in production went unopened for whole 15-minute codes while the same person later connected with a fresh prompt in 25 seconds.

- **The agent prompt.** When an owner or admin copies the agent prompt (onboarding, Docs, or **Connect your agent** in the sidebar), the copy carries a one-time setup token (`nm_setup_…`, 15 minutes). The agent exchanges it with `POST /v1/agent/setup` `{"token":"nm_setup_…","client_name":"<its name>"}`. Copying again replaces an unused token, and the dashboard says when the agent connected. An expired or replaced token answers `410` with a device code in `error.details[0]` addressed to the person who copied it: the agent shows them its link, and their dashboard shows the agent waiting with a button to approve.
- **A device code** (RFC 8628), for an agent started without the prompt: `POST /v1/agent/device` returns `device_code`, `user_code`, `verification_uri_complete`, `expires_in`, `interval` and `nextStep` (the link to show the person on its own line). The person opens the link (`/connect?code=…`), signs in, chooses the workspace and approves; the agent polls `POST /v1/agent/device/token` `{"device_code":"nm_device_…"}` every `interval` seconds, answered `400 AUTHORIZATION_PENDING` (each repeats the link), `SLOW_DOWN`, `ACCESS_DENIED` or `EXPIRED_TOKEN` until it returns the key once. The first `EXPIRED_TOKEN` for a code nobody approved carries a new code in `error.details[0]`, once.

Either way the key is named after the client the agent says it is ("Claude Code, set up <date>", or "Agent, set up <date>" without a `client_name`), and API keys shows that client. It has read, send and manage on every domain: it sends and manages domains, inboxes, receiving, webhooks, audience and campaigns. It **can't** create API keys, agent tokens, inbox connection keys, inbox keys or mail-client (IMAP/SMTP) passwords, and never reaches members or billing, so the agent can't make itself a credential that would outlive its key. It creates and reads inboxes with its own key. It is listed under API keys, where a person revokes it, and Activity records who set it up. Only an owner or admin mints a setup token or approves a code; tokens and codes are single-use, stored hashed and rate limited.

### Choose a catalog

| Client | URL | What `tools/list` returns |
|---|---|---|
| Plain MCP | `/mcp` | Resource tools such as `contacts` and `messages`, with compact schemas for each authorized action. `describe_tool` gives the full schema for one listed action. |
| OpenCode, Claude Code, Codex | `/mcp?codemode=false` (older names: `?codemode=true`, `?toolsets=all`) | Each authorized operation as a separate tool with input and output schemas, for clients that search or script tools themselves. OpenCode adds `?codemode=false` to a remote URL by itself. |

To narrow either listing, add `toolsets=inboxes,routing` (or choose from `rules`, `endpoints`, `sending`, `admin`). Toolsets filter the listing, not the grant. Inbox-only connections always list only their allowed inbox operations. Nightmail does not run arbitrary agent code. The [operation inventory](mcp-coverage.md) maps between the catalogs and identifies human-only steps.

### Workspaces

A signed-in connection names you, not a workspace. Every workspace tool takes an optional `workspace` argument (a workspace ID, slug or name) and acts there; without it, the connection's default is used. On every call Nightmail checks that you still belong to that workspace and acts with the token's scopes intersected with your role there: owners and admins get what the scopes allow, members read and send. A workspace you don't belong to gets `403 WORKSPACE_ACCESS_DENIED`, the same answer as one that doesn't exist.

- `workspaces` lists your workspaces, your role and the connection's access in each, and the default. In plain MCP it is the `workspaces` tool with action `list`.
- `setDefaultWorkspace({"workspace":"Acme"})` (plain MCP: `workspaces` with action `setDefault`) sets the default for this connection. You can also set it on the connection's page in **Settings → Account**.
- With no default set, calls use your only workspace, else the workspace you used last in the dashboard. If neither applies they fail with `WORKSPACE_REQUIRED`; pass `workspace`.

Credentials and objects a signed-in connection creates (API keys, agent tokens, endpoints, routes) belong to the workspace they were created in. They keep working only while you remain an owner or admin there and the connection is active.

### Several accounts

One signed-in MCP connection is one Anomaly account: the account you choose at Anomaly account when the client signs in. It reaches every workspace of that account, so one entry covers all of them. To use a personal and a work account from one agent, add the server twice under two names; both use the same endpoint.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "nightmail-personal": { "type": "remote", "url": "https://nightmail.dev/mcp" },
      "nightmail-work": { "type": "remote", "url": "https://nightmail.dev/mcp" }
    }
  }
}
```

OpenCode stores each entry's tokens under its own name, and Nightmail keeps one approval per account and client, so the two entries never share access. Sign each one in with its own account. Run `opencode2 mcp auth nightmail-personal` and pick your personal account in Anomaly account's chooser, then `opencode2 mcp auth nightmail-work` and pick your work account. If it signs you straight in as the wrong account, add the other account in Nightmail first (**Add account** in the account menu, which signs it in at Anomaly account too). Then run `opencode2 mcp logout nightmail-work` and `opencode2 mcp auth nightmail-work` again. Optionally add `?profile=work` to an entry's URL: Nightmail only shows it as a label in Settings, to tell entries apart; it never chooses an account, a workspace or any access.

### Signing in from a remote machine (SSH)

The client's sign-in ends with a redirect to `http://127.0.0.1:<port>/callback` on the machine running the client. When your browser is on another machine:

- **Paste back.** `opencode2 mcp auth nightmail` prints the sign-in URL. Open it on your laptop and approve; the browser then lands on a page that doesn't load. Copy that page's full address (`http://127.0.0.1:…/callback?code=…&state=…`) and paste it at OpenCode's prompt ("If the browser can't reach this machine, paste the URL it was redirected to"). The prompt needs an interactive terminal; the desktop and web apps have the same paste box in `/mcps`.
- **Forward the port.** Fix the callback port in the server's config, `"oauth": { "callback_port": 19876 }`, and connect with `ssh -L 19876:127.0.0.1:19876 <host>`. The redirect then reaches OpenCode through the tunnel.
- **No OAuth.** Use an [API key or agent token](#with-an-api-key-or-agent-token) instead: `"oauth": false` with `"headers": { "Authorization": "Bearer {env:NIGHTMAIL_API_KEY}" }`.

## Permissions

OAuth scopes map to the existing API permissions. Hosted Nightmail asks for `nightmail:*`; an installation asks for the prefix set in `OAUTH_SCOPE_PREFIX` (`bane` by default), and its resource metadata lists only those three. Tokens with either prefix work.

| Scope | Access |
| --- | --- |
| `nightmail:read` | Read contacts, email, delivery, and account data where API rules permit. |
| `nightmail:send` | Send email and use operations requiring send permission. |
| `nightmail:manage` | Management permission, including read and send. MCP safety exclusions still apply. |
| `offline_access` | Obtain a rotating refresh token, valid for up to 30 days. |

Legacy test-only approvals cannot be used or refreshed; reconnect and approve the client again. Authorization without an explicit scope requests read access. Writable connections additionally require `nightmail:send` or `nightmail:manage`. Supply literal `confirm: true` when the action schema requires it, and leave it out for read-only probes such as routing tests. The API enforces each operation's permission requirements. Access tokens expire after five minutes. Revoking the consent, disabling the client, or removing the user's OIDC approval denies further access, and queued sends recheck the durable approval before dispatch. Revocation cannot recall an in-flight or delivered email.

A connected agent is an **agent token**, one of Nightmail's three credentials (with API keys and app passwords): its sign-in, plus the short-lived tokens it makes for scripts. On the dashboard’s API keys page, a person can see their agents’ access, last use and tokens, choose an agent’s default workspace or revoke it in Nightmail. That ends that client's access here and every token it made, and revokes or holds what it set up. Signing the client in again at Anomaly account (a new consent there) starts a new approval, without what the revoked one created. To disconnect a client from your account everywhere, use **Connected apps** at [Anomaly account](https://account.anoma.ly/apps).

## Arguments and results

The plain listing shows required arguments and common options. For all fields, validation rules and the output schema of one action, call `describe_tool({"resource":"contacts","action":"list"})`. You can skip this lookup if you know the arguments: optional filters still go at the top level and nested fields stay in `body`. The server validates the full schema either way. Code Mode lists complete schemas directly. Writes require `confirm: true`; `idempotencyKey` is required for thread sends and optional for other writes.

For example, `contacts({"action":"get","contactId":"ct_…"})` and `getContact({"contactId":"ct_…"})` return the same contact. To list contacts instead, use action `list` or `listContacts`. Pass the returned `nextCursor` as `cursor` to continue.

On success, `structuredContent` is the resource or page itself, not an HTTP envelope. One compact JSON text block contains the same value. HTTP status and request ID are in `result._meta`; errors set `isError: true` and carry `{ "error": { "code": "…", "message": "…" } }`, and a permission refusal adds `required`, what the call needs (`api/README.md`, Errors). Mail reads also prepend an untrusted-content notice. Inbox attachment images are delivered in a separate image block.

In Code Mode the result of one operation can feed the next directly:

```js
const page = await tools.nightmail.listContacts({ limit: 10 });
if (page.data.length) return await tools.nightmail.getContact({ contactId: page.data[0].id });
```

Sending guidance: use `sendEmail` for one-off sends to **50 or fewer people total across the requested send**. Use campaigns for shared announcements or outreach to **more than 50 people**; do not split the audience into transactional batches or repeated sends to bypass this rule. Individual receipts, password resets and other event-triggered emails remain transactional regardless of total volume. This is MCP agent guidance, not a new API limit.

Campaign content remains **block HTML** shared with the dashboard composer. `createCampaign` and `updateCampaign` expose the API’s draft schemas, and `previewCampaign` renders the saved draft as HTML and plain text without preparing or sending its audience.

A one-off send can wait for a time: `sendEmail` with `scheduledAt` (a UTC instant, up to 30 days ahead), confirmed like any send. Until it goes, `rescheduleEmail` moves it and `cancelEmail` stops it; `listEmails` with `status=scheduled` lists the ones waiting.

After the required audience/content/time confirmation, use `sendCampaign` or `scheduleCampaign` with the current campaign `revision`. Nightmail snapshots the audience and starts a durable background workflow. HTTP 202 means accepted for validation and delivery, not sent or delivered.

A newsletter is a contact list with a sender: `createNewsletter` makes a new list one (`name`) or an existing list one (`listId`), and its ID and name are the list's. Its issues are ordinary campaigns to that list: create one with `createCampaign` and `audience.listId` set to the newsletter's ID, then test, confirm and send it as any campaign; `listCampaigns` with `listId` lists them. There are no separate issue operations. `getNewsletter` returns its readers (subscribed, unsuppressed members) and how many joined each day; `deleteNewsletter` keeps the list, its contacts and its campaigns.

### Inbound addresses and conversations

Reading workspace-wide message content requires unrestricted **manage** access: a signed-in grant or an API key. Receiving configuration requires an owner or admin of the workspace a call names, or an API key with manage on every domain; managing it also requires manage permission. Inbox-scoped connections instead get only the operations and inboxes their key or consent allows. Refresh the client’s catalog after changing a grant.

| Task | Code Mode tool |
| --- | --- |
| Check whether a domain receives mail | `listInboundDomains`, `getInboundDomain` (`domainId` from either the sending or receiving list) |
| Enable receiving for a verified domain | `enableInboundDomain` (`domainId`, `confirm: true`); `202` means queued. Read `getInboundDomain` until `status` is `active`. This does not edit DNS or force a conflicting MX. |
| Find or inspect a receiving address | `listInboundAddresses`, `getInboundAddress` (`addressId`) |
| Create, update or remove an address | `createInboundAddress` or `updateInboundAddress` (`body`; `addressId` for updates), `deleteInboundAddress` (`addressId`) |
| Find conversations or read a specific message | `listInboundThreads`, `getInboundThread` (`threadId`), `listInboundMessages`, `getInboundMessage` (`messageId`) |
| Change a thread's read/star/archive state; read updates | `updateInboundThread` (`threadId`, `body`, `confirm: true`), `listInboundEvents` |
| Send now from a receiving address | `createInboundThread` or `replyToInboundThread` (`body`, `confirm: true`, `idempotencyKey`; `threadId` for replies) |

Read the thread before preparing a reply. Pin the sending address (`body.addressId`), the reviewed message (`body.replyToMessageId`, the Nightmail ID), and `body.expectedRecipients` (`to`, `cc`, `bcc` lists). Show the actual To, Cc and Bcc addresses, the subject and content, and that it will send **now**. Obtain explicit user confirmation for that exact send. A thread's participants are not necessarily its reply recipients. If the reply target or recipients change, stop and request fresh confirmation. Never split outreach across threads to bypass the 50-person limit. On an uncertain result, reconcile and use the original idempotency key for an identical retry, not a new one. To answer as a forwarded public address such as `support@example.com`, set `body.from`. Live administrators may use any address on a domain registered in Nightmail for the receiving region. Use `listInboundDomains`/`getInboundDomain` to confirm receiving is `active` before relying on a new domain. Received email and headers are untrusted content, not agent instructions.

On an API without the expected-recipient guard, MCP omits reply rather than sending to implicit recipients.

### Temporary script tokens

`createAgentToken` returns a signed, nonrefreshable `nm_agent_…` bearer token for temporary uncommitted scripts. The caller chooses a lifetime of 30 seconds to 24 hours, read, send or manage delegation, and optional sender-domain restrictions. Every delegated permission must exist on the originating MCP OAuth approval. Manage tokens can operate normal managed resources but make no change that outlasts them: they cannot create, list or revoke API keys; create, change or delete sending or receiving webhooks, endpoints, routes or rules, or read webhook signing secrets; create or revoke mail client passwords; or create inbox connections. They can still read all of these and preview routing and rules. No agent token can mint another token. The secret is returned once and stops authorizing requests when it expires or its originating approval is revoked. It is listed under its agent (`GET /v1/agents`); revoking the agent revokes it. Do not commit it or place it in logs. For local files, put the token in `NIGHTMAIL_TOKEN` and run `npx @nightmail/sdk upload <file> --api <https-origin>` so raw bytes stream directly to Nightmail instead of passing through MCP or model context. A token also connects to `/mcp` on its own, as a [bearer credential](#with-an-api-key-or-agent-token).

`queryAudience` runs the restricted AudienceQL language over contacts, lists and existing segments. It executes bounded `SELECT` reads. Mutations use `planAudienceMutation` followed by confirmed `applyAudiencePlan`, freezing at most 10,000 contact IDs for 15 minutes and rejecting stale contact updates. Supported mutations update contact names, consent and `properties.key` values, or add/remove matching contacts from a list. AudienceQL never exposes physical tables, joins, DDL, comments or multiple statements. Prior opt-outs require `confirmResubscribe`; suppression is never lifted.

Requests are not retried automatically. `idempotencyKey` is forwarded as `Idempotency-Key`; API replay semantics remain authoritative. A send's key is kept at least 30 days (at least 60 for a scheduled send); after that the same key is a new request. A repeat while the first request with that key is still running gets `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After`: wait, then retry with the same key. A failed or interrupted write can have an uncertain outcome. Reconcile state before retrying. HTTP 202 means queued, not delivered.

### Feedback

`sendFeedback` (`POST /v1/feedback`) lets an agent tell the Nightmail team what got in its way: a `message` saying what happened and what would have made it easier, and optionally the `requestId` of a call that went wrong, the `operation` involved and a line of `context`. Any other field is ignored. The report is tied to the workspace and the credential the call came with; the body never names them. The server instructions ask agents to send one report per distinct problem in a task and then carry on.

Every connection whose credential can read lists it, whatever toolsets it asked for; in plain listings it is its own `sendFeedback` tool, with no action argument. It needs no `confirm`. A report is filed as a ticket in Nightmail's support inbox, showing the workspace and the key, sign-in or token that sent it, and on Glass's activity feed, and the team is emailed about it. A report that asks something about the workspace (the triage agent classifies it `question`) is answered by email to a person: whoever is behind the credential (a dashboard session, an MCP sign-in or its agent tokens), or for an API key the workspace's longest-standing owner, at their account's verified address, never one from the call. The answer never comes back through the tool: the response's `answer` says to whom (the caller's own address, masked; for an API key, "an owner of this workspace"), or why none will be sent (`nobody`: no one in the workspace can get support email; `capped`: today's answers are used up, 5 a credential, 10 a workspace and 200 in all), so the agent doesn't wait. Anything that looks like a key, token or password is removed before it is stored (`redacted` counts them). One credential may send 20 reports an hour and one workspace 50 (`429 FEEDBACK_RATE_LIMITED` with `Retry-After`).

## Hosting and safety

- OAuth discovery is available through the root and resource-path protected-resource metadata URLs. MCP clients register and authorize at the stage's account issuer using its discovery metadata.
- HTTP MCP is stateless, with modern and legacy stateless protocol support. The one long-lived response is an MCP Events stream (`events/stream`, SSE), which closes itself within 5 minutes. A legacy `initialize` returns an `MCP-Session-Id` covering each listed tool’s name, input and output schemas, and read-only and destructive hints at initialization. Rewording, reordering or publishing an additional tool leaves the ID valid; the next list includes new tools. If a held tool disappears, its contract or either approval hint changes, access changes the listing, or the server marks new instructions as mandatory, the next request gets 404. The client initializes a new session and lists the tools again. On the deploy that introduces this format, each connected legacy client re-initializes once on its next request. The ID packs three digest bytes per tool. If it would exceed 2,000 characters, initialization fails with HTTP 500 and the request log records `MCP_SESSION_ID_TOO_LARGE`; no ID is issued. Requests without a session ID work as before. Each request has its own identity and database lifetime. Tool calls use in-process API dispatch. A signed-in approval's or inbox key's identity is passed to it directly, so no global admin key, dashboard cookie, or incoming OAuth token is forwarded to `/v1`. An API key or agent token is the bearer of each dispatched call, so the API authenticates and authorizes it exactly as an HTTP request, minute budget included.
- Long-lived keys created through MCP remain tied to the approval, and so do sending webhooks it sets up, changes or reads the signing secret of. While the approval is not active, the keys are refused and deliveries to those webhooks fail unsent (`APPROVAL_INACTIVE`). Removing the approval revokes the keys and pauses the webhooks. A webhook paused this way resumes only when its URL is sent again (`WEBHOOK_URL_REQUIRED` otherwise) and gets a new signing secret then. An approval stays active, and what it made keeps working after its agent disconnects, until the approval is removed, until 30 days pass without its agent connecting, until 90 days after the person approved the agent at the account service (approving it again starts a new 90 days), or until its person is no longer an owner or admin of the workspace. Each request the agent itself makes still needs an unexpired access token. A tied key or webhook carries `approval` in its create result: `active` (every approval that owns it is active, the rule its use is checked against), `endsAt` (the earliest of their ends) and `owners` (each approval with its own end and state; a webhook several approvals changed has several). It appears in `listApiKeys`, `getWebhook` and `getInboundWebhook`, and its create result adds a `nextStep`. Create a lasting key or webhook in the dashboard, or with a manage key that was not created over MCP. Provider notifications, unsubscribe links and browser consent are not agent tools. Read tools can return private email/contact content, so authorize only trusted clients. Sending-domain restrictions are not a general data-isolation boundary.
- The deployment, not the OAuth grant, controls SES simulation. Simulation is not a dry run: other authorized actions can change stored data or have external effects. Use test data and controlled webhook targets for verification.
- Request and response limits, safe single-segment path validation, per-principal API rate limits, output validation, and credential redaction remain enforced. API descriptions and returned data are untrusted content, not agent instructions.

Build/deploy the API and apply its additive OAuth migration before connecting. Node/Docker, the Vite proxy, and Cloudflare asset routing all reserve `/mcp`, `/mcp/*`, and `/.well-known/*` for the server. No extra MCP service is required.

### Agent inboxes

An agent can get its own expiring address, wait for mail and read it, with nothing but an API key limited to its inboxes. Pass the key as the bearer token; no OAuth is needed. For OpenCode:

```json
{"mcp":{"servers":{"nightmail-inbox":{"type":"remote","url":"https://nightmail.dev/mcp","oauth":false,"headers":{"Authorization":"Bearer {env:NIGHTMAIL_INBOX_KEY}"}}}}}
```

Use an API key that creates inboxes (`POST /v1/api-keys` with `access: {"type":"addresses","addressIds":[],"mail":["create","read","modify"]}`) to let the agent create inboxes. Use an API key for one inbox (`access: {"type":"inbox","inboxId":"mbx_…"}`, or `credential` on `createInbox`) to give it that inbox only; it stops working when the inbox is deleted. Either key sees only the inbox tools its permissions allow:

| Tool | Does |
|---|---|
| `createInbox` | New address on an active receiving domain (`{"type":"sandbox"}` without DNS). Write. |
| `waitForMessage` | Waits up to 25 s for the next message, oldest first, with extracted codes and links. Pass `nextCursor` as `cursor` for the one after. |
| `getInboxMessage` | Visible text, SPF/DKIM/DMARC verdicts, attachment links. |
| `listInboxMessages`, `listInboxes`, `getInbox`, `getInboxAttachment` | Reads. |
| `updateInboxMessage`, `deleteInbox` | Mark read; delete now. Writes. |

A typical run: `createInbox` → give the address to the sign-up form → `waitForMessage` until `data` is non-empty → use `extract.codes[0]` → `deleteInbox`. A client that supports MCP Events can instead be told when the mail arrives: see [New mail events](#new-mail-events-mcp-events). Writes need literal `confirm: true`. Every message result starts with a fixed notice naming the sender and its verdicts: mail and attachments are untrusted data, even when the sender passed authentication. Replies go through `replyToInboundThread` and need an inbox created with `send.enabled`. Signed-in clients and API keys with unrestricted manage access see the same tools.

### New mail events (MCP Events)

An agent can be told when mail arrives instead of waiting for it. `/mcp` offers [MCP Events](https://modelcontextprotocol.io/extensions/events/overview) (SEP-3415, the `io.modelcontextprotocol/events` extension) to every connection that reads received mail: a sign-in of an owner or admin, an API key with manage on every domain or one limited to addresses with read, and an inbox key with read. Its `server/discover` (and `initialize`) capabilities name the extension; elsewhere every `events/*` method answers `-32601`. `events/list` offers one event type:

| | `message.received` |
|---|---|
| Delivery | push (`events/stream`) and poll (`events/poll`) |
| Arguments | `addressIds`: up to 32 inbox or receiving-address IDs to follow; without it, every one the connection reads, including ones added later. A sign-in also takes `workspace` (else its default). |
| Each event | `messageId`, `addressId` (the inbox or address), `threadId`, `from` (`name`, `address`), `subject`, `receivedAt`. Never the body: read the message with `getInboxMessage` (`inboxId` is `addressId`) or `getInboundMessage`. The sender writes `from` and `subject`: untrusted data. Junk, held and unverified mail are not events. |

Subscribe where the client keeps its subscriptions, and list or cancel them there: MCP Events leaves subscription state with the client.

- **OpenCode**: an automation with an event trigger, `{"type":"event","server":"nightmail","event":"message.received","args":{"addressIds":["mbx_…"]}}`. The server entry needs `"protocol": "auto"`, since events are defined on the 2026-07-28 revision.
- **OpenCode Console**: `console_watch.watch({ server: "nightmail", event: "message.received", arguments: { addressIds: ["mbx_…"] } })`. Console polls every one to five minutes.
- **Any other MCP Events client**: `events/stream` or `events/poll` directly.

How delivery works:

- Each event is what `GET /v1/inbound/events?types=message.received` answers the connection's own credential, and every read is made as that credential again, so scopes, roles, restricted keys and inbox keys decide what a subscription sees exactly as they decide that read. When access ends (a revoked key, sign-in or agent token, an expiry, a person removed or demoted), a stream ends with `notifications/events/terminated` (`-32024`) within about a second, and a poll answers `-32024`.
- **Stream**: `notifications/events/active` first, then an event about a second after each message is stored, and a heartbeat with the cursor when nothing arrives within the granted `heartbeatMs` (10 to 25 seconds, 25 by default). A stream closes itself after 5 minutes, or when the sign-in token it was opened with expires, with an empty result; the client opens it again from its last cursor. Each second a stream may wait counts as one request against the credential's minute budget, as long polls do. A credential holds at most 10 open streams: an eleventh ends its oldest, which gets `notifications/events/terminated` (`-32025`, `data.limit: "subscriptions"`). A workspace holds at most 50, and past that a new stream is refused with the same error. Follow several inboxes with one subscription's `addressIds`.
- **Poll**: `cursor: null` starts from now; pass back the returned `cursor`. It suggests polling every 30 seconds (`nextPollMs`), at once while `hasMore`.
- A cursor older than 7 days, or than the client's `maxAgeMs`, starts again from now with `truncated: true`: list the inbox's messages to catch up.
- Webhook delivery (`events/subscribe`) isn't offered (`-32026`).

### Receiving tools

Receiving tools (routing, rules, endpoints, inbound addresses and domains) follow the role: an owner or admin of the workspace a call names, with an approval that has `nightmail:manage`, or an API key with manage on every domain. There is no separate consent checkbox. Approvals whose receiving consent was turned off before this change had their receiving objects held at the migration; they don't come back. Manage writes require `confirm:true`. The rule plan is a single versioned bundle. Revoking a contributing grant disables the bundle rather than guessing which remaining scripts still depend on it. It also disables owned destinations and routes and revokes owned inbox keys. Until then, routes, rules, endpoints and inbox keys made over MCP work while their approval is active, as described under [Hosting and safety](#hosting-and-safety). Endpoint URLs are write-only, so a Slack, Discord or webhook destination held this way resumes only after its URL is sent again (`ENDPOINT_URL_REQUIRED` otherwise). Already delivered mail cannot be recalled. A sign-in can't be limited to inboxes: to give an agent only some inboxes, connect it with a key from `createInboxConnection` (`auth:'key'`). See the [agent example](inboxes.md#agent-inbox-over-mcp) and [operation inventory](mcp-coverage.md).

## Account authorization and Nightmail approvals

Set `ACCOUNT_ISSUER` to the HTTPS issuer that signs access tokens for this installation. Resource discovery is available at `${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`. The resource indicator is the absolute `${PUBLIC_URL}/mcp` URI, including `/mcp`. Clients discover and request authorization at the issuer. During cutover each user authorizes their client again; grants issued before the rename cannot be exchanged at the new issuer.

`nightmail:read`, `nightmail:send` and `nightmail:manage` (or the `bane:` names) request the corresponding Nightmail permissions; a 401 challenge names the three the installation asks for, and you narrow them when approving. The resource verifies the JWT signature and audience (`${PUBLIC_URL}/mcp`, with any query string such as `?codemode=false`). It requires a matching Nightmail `(issuer, subject)` identity and checks live workspace membership and role on every tool call. Members cannot use `manage`. Hosted Nightmail also requires every access token to come from one of the account service's sign-in methods it accepts (`acr` is one of `ACCOUNT_REQUIRED_ACR`: GitHub, Google, email link or password); other tokens get a 401 `insufficient_user_authentication` challenge. A sender-constrained access token requires its matching DPoP proof on every request.

For hosted Nightmail, the resource identifiers are `https://dev.nightmail.dev/mcp` and `https://nightmail.dev/mcp`. The account issuer supplies the same public subject on dashboard sign-in and on MCP access tokens. Nightmail maintains one approval per user and client ID, including across token refreshes. In **Settings → Account**, revoke a client to block the tokens of its current consent in Nightmail. Use the **Connected apps** link to revoke the grant at the issuer. The cutover shows legacy approvals as expired and revokes their tokens and derived credentials. Reconnect through the account service to authorize again.
