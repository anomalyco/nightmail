# Nightmail MCP

Connect an MCP client to **`https://YOUR_NIGHTMAIL_DOMAIN/mcp`**. The MCP server is part of the Nightmail API, so no local process is needed. This installation uses **https://nightmail.dev/mcp**.

There are two ways to connect:

| Connect with | It acts as | Set up |
|---|---|---|
| **Sign in as you** (OAuth) | You, in any of your workspaces, with the access you approve (read, send or manage) intersected with your role in each | Add the URL; the client opens your browser to sign in |
| **An API key or agent token** | That credential, in its own workspace, with exactly its permissions | Add the URL with an `Authorization: Bearer …` header; no browser |

Keys limited to receiving addresses or one agent inbox (`nm_mbx_…`) connect the same way as other keys. See [Agent inboxes](#agent-inboxes).

If you authorised your client against `https://opensend.mx/mcp` or `https://bane.mx/mcp`, reconnect it to `https://nightmail.dev/mcp` and approve access again.

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

In the dashboard, **API keys → Create key** shows this setup for OpenCode, Claude Code and Cursor right after the key is made. Every tool call is an API request made with that credential: Nightmail checks the key on each call (revoked, expired, its minute budget, an agent token's approval), and the API answers exactly as it would over HTTP. The listing offers what the API allows the credential. A temporary agent token never administers keys, webhooks, rituals or routes, and only a signed-in approval mints agent tokens. Tools take no `workspace` argument: naming the key's own workspace is accepted, and any other is refused with `403 WORKSPACE_ACCESS_DENIED`. A key is the right choice for a headless agent or a remote machine where a browser sign-in is awkward. Keep it out of committed configs: reference an environment variable, as above.

### Choose a catalog

| Client | URL | What `tools/list` returns |
|---|---|---|
| Plain MCP | `/mcp` | Resource tools such as `contacts` and `messages`, with compact schemas for each authorized action. `describe_tool` gives the full schema for one listed action. |
| OpenCode, Claude Code, Codex | `/mcp?codemode=false` (older names: `?codemode=true`, `?toolsets=all`) | Each authorized operation as a separate tool with input and output schemas, for clients that search or script tools themselves. OpenCode adds `?codemode=false` to a remote URL by itself. |

To narrow either listing, add `toolsets=inboxes,routing` (or choose from `rituals`, `endpoints`, `sending`, `admin`). Toolsets filter the listing, not the grant. Inbox-only connections always list only their allowed inbox operations. Nightmail does not run arbitrary agent code. The [operation inventory](mcp-coverage.md) maps between the catalogs and identifies human-only steps.

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

OAuth scopes map to the existing API permissions:

| Scope | Access |
| --- | --- |
| `bane:read` | Read contacts, email, delivery, and account data where API rules permit. |
| `bane:send` | Send email and use operations requiring send permission. |
| `bane:manage` | Management permission, including read and send. MCP safety exclusions still apply. |
| `offline_access` | Obtain a rotating refresh token, valid for up to 30 days. |

Legacy test-only approvals cannot be used or refreshed; reconnect and approve the client again. Authorization without an explicit scope requests read access. Writable connections additionally require `bane:send` or `bane:manage`. Supply literal `confirm: true` when the action schema requires it, and leave it out for read-only probes such as routing tests. The API enforces each operation's permission requirements. Access tokens expire after five minutes. Revoking the consent, disabling the client, or removing the user's OIDC approval denies further access, and queued sends recheck the durable approval before dispatch. Revocation cannot recall an in-flight or delivered email.

A connected agent is an **agent token**, one of Nightmail's three credentials (with API keys and app passwords): its sign-in, plus the short-lived tokens it makes for scripts. Each person lists their agents with `GET /v1/agents` (the API keys page shows them with their access, last use and tokens). `POST /v1/mcp-connections/{id}/workspace` sets one's default workspace, and `POST /v1/agents/{id}/revoke` revokes it in Nightmail. That ends that client's access here and every token it made, and revokes or holds what it set up. Signing the client in again at Anomaly account (a new consent there) starts a new approval, without what the revoked one created. To disconnect a client from your account everywhere, use **Connected apps** at [Anomaly account](https://account.anoma.ly/apps).

## Arguments and results

The plain listing shows required arguments and common options. For all fields, validation rules and the output schema of one action, call `describe_tool({"resource":"contacts","action":"list"})`. You can skip this lookup if you know the arguments: optional filters still go at the top level and nested fields stay in `body`. The server validates the full schema either way. Code Mode lists complete schemas directly. Writes require `confirm: true`; `idempotencyKey` is required for thread sends and optional for other writes.

For example, `contacts({"action":"get","contactId":"ct_…"})` and `getContact({"contactId":"ct_…"})` return the same contact. To list contacts instead, use action `list` or `listContacts`. Pass the returned `nextCursor` as `cursor` to continue.

On success, `structuredContent` is the resource or page itself, not an HTTP envelope. One compact JSON text block contains the same value. HTTP status and request ID are in `result._meta`; errors set `isError: true` and carry `{ "error": { "code": "…", "message": "…" } }`. Mail reads also prepend an untrusted-content notice. Inbox attachment images are delivered in a separate image block.

In Code Mode the result of one operation can feed the next directly:

```js
const page = await tools.nightmail.listContacts({ limit: 10 });
if (page.data.length) return await tools.nightmail.getContact({ contactId: page.data[0].id });
```

Sending guidance: use `sendEmail` for one-off sends to **50 or fewer people total across the requested send**. Use campaigns for shared announcements or outreach to **more than 50 people**; do not split the audience into transactional batches or repeated sends to bypass this rule. Individual receipts, password resets and other event-triggered emails remain transactional regardless of total volume. This is MCP agent guidance, not a new API limit.

Campaign content remains **block HTML** shared with the dashboard composer. `createCampaign` and `updateCampaign` expose the API’s draft schemas, and `previewCampaign` renders the saved draft as HTML and plain text without preparing or sending its audience.

After the required audience/content/time confirmation, use `sendCampaign` or `scheduleCampaign` with the current campaign `revision`. Nightmail snapshots the audience and starts a durable background workflow. HTTP 202 means accepted for validation and delivery, not sent or delivered.

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

`createAgentToken` returns a signed, nonrefreshable `nm_agent_…` bearer token for temporary uncommitted scripts. The caller chooses a lifetime of 30 seconds to 24 hours, read, send or manage delegation, and optional sender-domain restrictions. Every delegated permission must exist on the originating MCP OAuth approval. Manage tokens can operate normal managed resources but make no change that outlasts them: they cannot create, list or revoke API keys; create, change or delete sending or receiving webhooks, endpoints, routes or rituals, or read webhook signing secrets; create or revoke mail client passwords; or create inbox connections. They can still read all of these and preview routing and rituals. No agent token can mint another token. The secret is returned once and stops authorizing requests when it expires or its originating approval is revoked. It is listed under its agent (`GET /v1/agents`); revoking the agent revokes it. Do not commit it or place it in logs. For local files, put the token in `NIGHTMAIL_TOKEN` and run `npx @nightmail/sdk upload <file> --api <https-origin>` so raw bytes stream directly to Nightmail instead of passing through MCP or model context. A token also connects to `/mcp` on its own, as a [bearer credential](#with-an-api-key-or-agent-token).

`queryAudience` runs the restricted AudienceQL language over contacts, lists and existing segments. It executes bounded `SELECT` reads. Mutations use `planAudienceMutation` followed by confirmed `applyAudiencePlan`, freezing at most 10,000 contact IDs for 15 minutes and rejecting stale contact updates. Supported mutations update contact names, consent and `properties.key` values, or add/remove matching contacts from a list. AudienceQL never exposes physical tables, joins, DDL, comments or multiple statements. Prior opt-outs require `confirmResubscribe`; suppression is never lifted.

Requests are not retried automatically. `idempotencyKey` is forwarded as `Idempotency-Key`; API replay semantics remain authoritative. A repeat while the first request with that key is still running gets `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After`: wait, then retry with the same key. A failed or interrupted write can have an uncertain outcome. Reconcile state before retrying. HTTP 202 means queued, not delivered.

## Hosting and safety

- OAuth discovery is available through the root and resource-path protected-resource metadata URLs. MCP clients register and authorize at the stage's account issuer using its discovery metadata.
- HTTP MCP is stateless, with modern and legacy stateless protocol support. Each request has its own identity and database lifetime. Tool calls use in-process API dispatch. A signed-in approval's or inbox key's identity is passed to it directly, so no global admin key, dashboard cookie, or incoming OAuth token is forwarded to `/v1`. An API key or agent token is the bearer of each dispatched call, so the API authenticates and authorizes it exactly as an HTTP request, minute budget included.
- Long-lived keys created through MCP remain tied to the approval, and so do sending webhooks it sets up, changes or reads the signing secret of. While the approval is not active, the keys are refused and deliveries to those webhooks fail unsent (`APPROVAL_INACTIVE`). Removing the approval revokes the keys and pauses the webhooks. A webhook paused this way resumes only when its URL is sent again (`WEBHOOK_URL_REQUIRED` otherwise) and gets a new signing secret then. Provider notifications, unsubscribe links and browser consent are not agent tools. Read tools can return private email/contact content, so authorize only trusted clients. Sending-domain restrictions are not a general data-isolation boundary.
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

A typical run: `createInbox` → give the address to the sign-up form → `waitForMessage` until `data` is non-empty → use `extract.codes[0]` → `deleteInbox`. Writes need literal `confirm: true`. Every message result starts with a fixed notice naming the sender and its verdicts: mail and attachments are untrusted data, even when the sender passed authentication. Replies go through `replyToInboundThread` and need an inbox created with `send.enabled`. Signed-in clients and API keys with unrestricted manage access see the same tools.

### Receiving tools

Receiving tools (routing, rituals, endpoints, inbound addresses and domains) follow the role: an owner or admin of the workspace a call names, with an approval that has `bane:manage`, or an API key with manage on every domain. There is no separate consent checkbox. Approvals whose receiving consent was turned off before this change had their receiving objects held at the migration; they don't come back. Manage writes require `confirm:true`. The ritual plan is a single versioned bundle. Revoking a contributing grant disables the bundle rather than guessing which remaining scripts still depend on it. It also disables owned destinations and routes and revokes owned inbox keys. Endpoint URLs are write-only, so a Slack, Discord or webhook destination held this way resumes only after its URL is sent again (`ENDPOINT_URL_REQUIRED` otherwise). Already delivered mail cannot be recalled. Select **Only selected inboxes** instead of workspace access to narrow OAuth discovery and API dispatch to those inbox IDs. See the [agent example](inboxes.md#agent-inbox-over-mcp) and [operation inventory](mcp-coverage.md).

## Account authorization and Nightmail approvals

Set `ACCOUNT_ISSUER` to the HTTPS issuer that signs access tokens for this installation. Resource discovery is available at `${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`. The resource indicator is the absolute `${PUBLIC_URL}/mcp` URI, including `/mcp`. Clients discover and request authorization at the issuer. During cutover each user authorizes their client again; existing Bane-issued grants cannot be exchanged at the new issuer.

`bane:read`, `bane:send` and `bane:manage` request the corresponding Nightmail permissions; a 401 challenge names all three, and you narrow them when approving. The resource verifies the JWT signature and audience (`${PUBLIC_URL}/mcp`, with any query string such as `?codemode=false`). It requires a matching Nightmail `(issuer, subject)` identity and checks live workspace membership and role on every tool call. Members cannot use `manage`. Hosted Nightmail also requires every access token to carry `acr=urn:anomaly:acr:google` (`ACCOUNT_REQUIRED_ACR`); other tokens get a 401 `insufficient_user_authentication` challenge. A sender-constrained access token requires its matching DPoP proof on every request.

For hosted Nightmail, the resource identifiers are `https://dev.nightmail.dev/mcp` and `https://nightmail.dev/mcp`. The account issuer supplies the same public subject on dashboard sign-in and on MCP access tokens. Nightmail maintains one approval per user and client ID, including across token refreshes. In **Settings → Account**, revoke a client to block the tokens of its current consent in Nightmail. Use the **Connected apps** link to revoke the grant at the issuer. The cutover shows legacy approvals as expired and revokes their tokens and derived credentials. Reconnect through the account service to authorize again.
