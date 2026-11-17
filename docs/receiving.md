# Receiving

Receiving is where mail that arrives at your domains is routed, filtered and sent on. The dashboard uses the same names as the API: **routes**, **rituals**, **endpoints** and the **catch-all**. The words below are the words on screen (`app/src/features/inbound/concepts.ts`); change both together.

![Receiving: the Routes tab, each route reading left to right from the address to its rituals to where its mail goes](images/receiving/routes.png)

- [Concepts](#concepts)
- [Kinds of route](#kinds-of-route)
- [What happens to mail](#what-happens-to-mail)
- [An address's page](#an-addresss-page)
- [Catch-all](#catch-all)
- [Trace and Try it](#trace-and-try-it)
- [Where everything is](#where-everything-is)
- [API, SDK and MCP](#api-sdk-and-mcp)

## Concepts

| | What it is | Example |
|---|---|---|
| **Routes** | Every address that receives mail, and where its mail goes. | `support@acme.com → triage → Inbox, Slack support` |
| **Rituals** | Short scripts that run on a route's mail: label it, filter it, or send it on. | If the subject mentions a refund, label it and post it to Slack. |
| **Endpoints** | Places mail can be sent: Slack, Discord, a webhook or a forward. A named one is called from rituals; a webhook can also subscribe to events. | `endpoints.support({ text: email.subject })` |
| **Trace** | Dry-run an email through your routes and rituals; nothing is sent or saved. | |

Rituals and endpoints are described in full in [rituals.md](rituals.md); agent inboxes in [inboxes.md](inboxes.md).

## Kinds of route

The Routes tab lists every kind in one table and filters by kind. Each row reads **Route | Rituals | Goes to | Unread | Last mail**.

| Filter | What it shows | Example |
|---|---|---|
| All | Every address that receives mail, and where its mail goes. | `support@acme.com → triage → Inbox, Slack support` |
| Addresses | Each keeps its own threads in the Inbox; a route can send its mail elsewhere. | `support@acme.com` |
| Patterns | A pattern catches many addresses with `*`. | `reply+*@acme.com` catches `reply+4821@acme.com` |
| Catch-alls | What happens to mail for an address that doesn't exist. | `*@acme.com` |
| Agent inboxes | Expiring addresses that agents and tests create and read over the API or MCP. | |
| Auto-created | Addresses a catch-all created for new recipients. | |

Under each address, a few words say what the row is: *No inbox of its own* (a route for an address without an inbox), *Pattern*, *Catch-all*, *Agent inbox* or *Created by the catch-all*.

A route that has no ritual yet says so in its row (**No ritual · add**), so what an address could do is always visible next to what it does.

## What happens to mail

**Goes to** lists where a route's mail ends up: routing first, then what its rituals can send it to, marked *via* the ritual (a ritual may send only some mail there).

| On screen | Meaning | API (`to[].type`) |
|---|---|---|
| Inbox | The address keeps the thread. | `inbox` |
| Webhook, Slack, Discord, Forward | An endpoint. | `webhook`, `slack`, `discord`, `forward` |
| Stored, no inbox | Kept and readable over the API by message ID, but in no inbox. | `store` |
| Dropped | Not stored. | `drop` |
| New address per recipient | The domain's catch-all creates an address for each new recipient. | `create_address` |

A route can deliver to inboxes and webhooks. Slack, Discord and forwards are sent by a ritual.

The list is complete: routing targets and ritual targets always show, and webhooks subscribed to an address's received mail show active ones first, then paused ones. An address with more than 50 subscribers shows the first 50 and says how many more there are, with a link to every one (Event webhooks, filtered to that address).

## An address's page

Opening a route shows the address as three steps, each with what you can do there:

| Step | Line on screen | Actions | When empty |
|---|---|---|---|
| **Route** | Mail sent to these addresses. | Add alias, Add pattern | |
| **Rituals** | Run in order on every message. | Attach a ritual, New ritual, detach | No ritual yet |
| **Goes to** | Where the mail ends up. | Add an endpoint, Edit route | Only its inbox |

![An address's page: Route, Rituals and Goes to, with recent mail and settings below](images/receiving/address.png)

Below the steps are its recent mail (open any thread in the Inbox) and its settings: display name, aliases and patterns. **Trace** in the header runs an email to this address through its route and rituals.

## Catch-all

Catch-all: what happens to mail for an address that doesn't exist on this domain. It is set per domain on its Domains page, and the Routes tab shows it as a Catch-alls row.

| Option | API (`catchAll`) |
|---|---|
| Store it, no inbox | `store` |
| Create an address | `create_address` |

An explicit `*@host` route takes precedence over the domain's catch-all. Domains show sending and receiving on one page; Receiving doesn't list domains of its own.

![A domain's page: sending status, then receiving status, its addresses and the catch-all](images/receiving/domain.png)

## Trace and Try it

**Trace** runs an email through your routes and rituals with the dry run (`testRituals`). Pick recent mail, a sample email (when nothing has arrived yet, the sample stands in) or paste a message. Each ritual's source appears with its conditions; one at a time they light up true or false, omen answers fill in, then the actions (`→ junk`, `→ Slack support`) and the result: which inboxes and endpoints get the mail, its labels, and whether it's junk.

![Trace: a ritual's conditions evaluated true and false, the omen score, its actions and where the mail ends up](images/receiving/trace.png)

**Try it** in the ritual editor does the same for the ritual you're writing, unsaved, as if it were attached to the address the email was sent to. Each omen gets a slider (default 0.5) for the answer Jev would give; Jev is never asked. Nothing is sent or saved in either. With reduced motion, the whole trace shows at once.

## Where everything is

Everything is at most two clicks from Receiving.

| Task | Where |
|---|---|
| See every address and where its mail goes | Receiving → Routes |
| Create an address | Receiving → New address |
| Add an alias or pattern, attach a ritual, add an endpoint | Receiving → Routes → the address |
| Add a ready-made ritual or write one | Receiving → Rituals → New ritual |
| Turn a ritual off, edit, trace or delete it | Receiving → Rituals → its switch or ⋯ menu |
| Edit, attach or try a script | Receiving → Rituals → the ritual (Edit as code for a ready-made one) |
| Create, test, pause or delete an endpoint | Receiving → Endpoints |
| Subscribe a webhook to inbound events | Receiving → Endpoints → the webhook |
| See every webhook that gets an address's mail | Receiving → Routes → the address → Goes to → more webhooks |
| Create an agent inbox | Receiving → Routes → Agent inboxes → New agent inbox |
| Test what would happen to an email | Receiving → Trace |
| Set up receiving or change a catch-all | Domains → the domain |

Older links keep working: `/receiving/routing` opens Routes, and `/receiving/endpoints` and `/receiving/webhooks` open the Endpoints tab.

## API, SDK and MCP

The Receiving screen is one read: `getInboundOverview` (`GET /v1/inbound/overview`) returns a page of routes merged across kinds, each with the rituals that run on it and where its mail goes, plus counts per kind, the rituals, up to 100 endpoints and 100 inbound webhooks (`endpointsTruncated` says when there are more; read them all with `listInboundEndpoints`, following `nextCursor`) and the domains. Each route's `to` is complete except for webhook subscribers beyond 50; then `toTruncated` is true, `toTotal` counts every target and `toMore` is the `listInboundWebhooks?addressId=…&eventType=message.received` path that lists them all. Filter with `kind` (`address`, `inbox`, `route`, `pattern`, `catch_all`, comma-separated), `origin` (address rows only: `api` or `auto`), `domain` and `q`; page with `cursor`. It costs two database statements whatever the number of routes.

Access matches the other receiving reads: members and scoped keys see only their own addresses; the full view needs a manage credential, and credentials that come from an MCP approval also need its explicit receiving consent. Over MCP it is offered exactly to the approvals REST allows. Webhook, Slack and Discord URLs are write-only: only the last four characters are returned.

| Task | Operation (also the MCP tool name) |
|---|---|
| Everything on the Routes tab | `getInboundOverview` |
| Addresses, aliases and patterns | `listInboundAddresses`, `createInboundAddress`, `updateInboundAddress` (`aliases`, `rules`); deprecated, see below |
| An address's mail and folders | `listInboxMessages`, `getInboxMessage`, `listInboxFolders`, `moveInboxMessage` and the other inbox mail operations, with the address ID |
| Routes | `listRoutes`, `createRoute`, `updateRoute`, `deleteRoute`, `testRouting` |
| Catch-all | `updateInboundDomain` (`catchAll`) |
| Rituals and Try it | `saveRitual`, `attachRituals`, `testRituals` (trace rows carry a step-by-step `timeline`) |
| Endpoints | `listInboundEndpoints` (every endpoint, named or not, a page at a time; `addressId` keeps the webhooks that get an address's received mail), `listEndpoints`, `createEndpoint`, `updateEndpoint`, `testEndpoint`, `deleteEndpoint` |
| Inbound webhooks | `listInboundWebhooks` (`cursor`, `limit`, `addressId`, `eventType`), `getInboundWebhook`, `createInboundWebhook`, `updateInboundWebhook` |

Every address is an inbox. It has folders, UIDs and one writer for its thread and message state, like an agent inbox, so the inbox mail and folder operations (`/v1/inboxes/{id}/messages`, `/v1/inboxes/{id}/folders`) take an address ID too. A temporary address (`ttlSeconds`) is an inbox whose lease is `expiresAt` alone: it stops receiving then and is kept. An address can still start threads and keep its own send limits, which an agent inbox can't. The address operations (`listInboundAddresses`, `createInboundAddress`, `getInboundAddress`, `updateInboundAddress`, `deleteInboundAddress`) are deprecated aliases until the domain cutover, which removes them and lets `/v1/inboxes` list and create addresses too. Until then `/v1/inboxes` and `getInbox` show agent inboxes only, because the `Inbox` response can't describe an address without a breaking change. Deleting an address releases it: its threads and folders go, and its stored mail is kept.

Endpoints and webhooks are one model. Every endpoint, whatever its type, is one row with one ID (`mwh_…` for a webhook, `con_…` for Slack, Discord and forwards); a webhook's `key` is its endpoint name. `/v1/endpoints` lists and changes named endpoints of every type, and `/v1/inbound/webhooks` lists and changes webhooks, named or not. Both go through the same writer (`api/src/endpoints.ts`), so names, caps (32 active webhooks with event subscriptions, 500 active route-only webhooks, 50 Slack, Discord and forward endpoints), the in-use checks and pause and resume are the same through either.

```sh
curl "$BANE/v1/inbound/overview?kind=address,route&origin=api&q=support" -H "Authorization: Bearer $KEY"
```
