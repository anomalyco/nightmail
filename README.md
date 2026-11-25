<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="app/public/brand/nightmail-lockup-256-dark.svg">
    <img src="app/public/brand/nightmail-lockup-256-light.svg" alt="nightmail" height="32">
  </picture>
</h1>

<a href="https://opencode.ai"><picture><source media="(prefers-color-scheme: dark)" srcset="https://opencode.ai/brand/badges/opencode-built-with-g-dark-20.svg"><img alt="Built with OpenCode" src="https://opencode.ai/brand/badges/opencode-built-with-g-light-20.svg" height="20" /></picture></a>

Self-hosted transactional email, newsletters, campaigns, and inbound conversations with Amazon SES. Use **Receiving** to route mail to addresses, run [rules](docs/rules.md) on it, send it to endpoints, and read and reply to threads ([how it fits together](docs/receiving.md)). One installation, OIDC sign-in, and one public API shared by the dashboard, SDK, and MCP server.

![Nightmail dashboard showing sending activity, delivery metrics, and recent campaigns](docs/images/dashboard.png)

<p>
  <a href="docs/images/campaign-composer.png"><img src="docs/images/campaign-composer.png" alt="Campaign composer with visual email editing and audience selection" width="49%" /></a>
  <a href="docs/images/email-logs.png"><img src="docs/images/email-logs.png" alt="Email logs with delivery statuses, recipients, and filtering" width="49%" /></a>
</p>

## Start here

1. Clone the repo:

   ```sh
   git clone https://github.com/anomalyco/nightmail.git
   cd nightmail
   ```

2. Open the repo in your coding agent and paste:

   ```text
   Help me set up Nightmail for my use case. Explore this repo and read
   api/README.md first. Ask what I want to send, whether I prefer Docker
   or Cloudflare, and what infrastructure I already have. Recommend the
   simplest setup and explain the plan before making changes. Use my own
   accounts and resources, keep secrets out of git, and start with simulated
   sending. Ask before provisioning, deploying, or sending real email.
   ```

The hosted service is at [nightmail.dev](https://nightmail.dev); its [production Worker configuration](api/wrangler.prod.jsonc) is separate from dev. Its daily limits follow each workspace's sender score: see [how sending limits work](docs/sending-limits.md).

Prefer a manual setup? Start with [Docker](api/README.md#docker-quickstart) or [Cloudflare](api/README.md#cloudflare). For development, see the [local setup](api/README.md#local-development).

## TypeScript SDK

Install [`@nightmail/sdk`](https://www.npmjs.com/package/@nightmail/sdk) from npm:

```sh
npm install @nightmail/sdk
```

See the [SDK guide](sdk/README.md) for usage examples, or [connect an MCP client](docs/mcp.md).

## CI and deployments

1. **Pull request:** `CI` selects the [suites affected by the change](docs/ci.md#which-changes-select-which-suites), including the dashboard and SDK builds, Worker bundles, types, generated docs, and acceptance against disposable PostgreSQL and S3 fixtures. A breaking OpenAPI change fails the build unless maintainers apply **`api-breaking`**. The label waives compatibility only. On a dev push, the waiver applies only when every pushed commit belongs to that merged PR.
2. **Merge to `dev`:** the queue has already tested its exact merge SHA, so its push starts `Deploy` without repeating CI. A direct push still gets full CI. The deploy builds that SHA and rechecks the dev tip under the deployment lock. Superseded commits are skipped before migration. The current commit applies Pulumi first when what Pulumi reads changed (see [docs/ci.md](docs/ci.md#releasing-to-production)), then migrates, deploys and runs live tests on `dev.nightmail.dev`; its summary and JSON report distinguish success, expected rejections, skips and failures.
3. **Production:** require the passing dev deploy and live E2E for the exact SHA, plus the successful dev queue CI (or direct dev push CI). Then fast-forward `production` to that exact commit: `git push origin <sha>:refs/heads/production`. The push is the only production deploy trigger. Watch it through the health checks; see [Releasing to production](docs/ci.md#releasing-to-production) for verification and recovery.
4. **SDK release:** dispatch `Release SDK` from `dev` with `bump` (`patch`, `minor` or `major`). Its `build` job runs repository code with no environment, secrets or OIDC token and uploads the packed tarball; its `publish` job runs in the `release` environment (where a reviewer approves), never checks out the repository, publishes that tarball through npm trusted publishing (the environment's OIDC token; there is no npm token), then tags the build's commit `v<version>` and creates the GitHub release. The version comes from the newest tag, or from `sdk/package.json` before the first tag, and is never committed back, so `dev` stays restricted and `production` stays fast-forward only. Only `dev` may deploy the `release` environment.

Configure **environment-scoped** variables (not repository-wide). The deploy secrets
live in AWS Secrets Manager (`us-east-1`, account `604439173067`) and are read through
GitHub OIDC by each environment's own role, `arn:aws:iam::604439173067:role/github/nightmail-dev`
or `arn:aws:iam::604439173067:role/github/nightmail-production`:

| Environment | AWS Secrets Manager | Variables |
|---|---|---|
| `dev` | `DATABASE_URL`, `BETTER_AUTH_SECRET` (the root secret), `ACCOUNT_CLIENT_PRIVATE_KEY`, `TYPESAFE_API_KEY`, `E2E_API_KEY`; `MAILGW_API_TOKEN` while the gateway is enabled | `E2E_DOMAIN`, `E2E_DOMAIN_ID` |
| `production` | `DATABASE_URL`, `BETTER_AUTH_SECRET` (the root secret), `ACCOUNT_CLIENT_PRIVATE_KEY`, `TYPESAFE_API_KEY`; `MAILGW_API_TOKEN` while the gateway is enabled | `PROD_DEPLOY_ENABLED` |

For a self-hosted installation, register a confidential OIDC client with your issuer and follow the [dashboard sign-in setup](api/README.md#dashboard-sign-in).

`MAILGW_API_TOKEN` is the IMAP/SMTP gateway's shared key and must equal the stage's `mail-gateway/api-token`. The committed `bane:mailGatewayEnabled` in `infra/pulumi/Pulumi.<stage>.yaml` decides how the Worker deploy treats it:

- **True:** the deploy reads the key inside its Worker step and binds it, and stops if the key is missing or invalid.
- **False (the default):** the deploy removes the Worker's binding, so gateway calls get 403 `PROTOCOL_DENIED`.

Dev sets it true. Production stays false until the production runbook's follow-up PR, opened once its secrets, database role, image and DNS are in place. See the [dev](gateway/PHASE2.md#dev-turn-on-runbook) and [production](gateway/PHASE2.md#production-turn-on-runbook) turn-on runbooks, and [IMAP and SMTP](api/README.md#imap-and-smtp) for what customers get, including send-only SMTP logins for apps.

**Both stages use the same key names.** The stage comes from the GitHub environment,
which selects that environment's variables, and from the `nightmail/<stage>/` folder, which
selects that stage's secrets. Never prefix a key with `DEV_` or `PROD_`; the deploy reads
`nightmail/${stage}/DATABASE_URL` and `vars.E2E_DOMAIN` for either stage. Only dev
runs a live E2E, so only `nightmail/dev/` holds an `E2E_API_KEY`. `PROD_DEPLOY_ENABLED` keeps
its name for now because the production freeze check reads it.

The Cloudflare token is not stored anywhere. Each deploy mints a 30-minute token from the
token issuer in `anomalyco/secrets` with the environment's own role, scoped to the stage's
Worker, its custom-domain zones and the Pulumi resources (see the `cloudflare` entry for
`bane/dev` and `bane/production` in that repo's `config.ts`). The issuer restricts each
token to the IP that minted it, so a token only works on the job that asked for it. Live API
keys need read/send/manage on the dedicated **E2E** workspace, not on a customer workspace.

**Production freeze:** production jobs require `PROD_DEPLOY_ENABLED` to be the exact lowercase string `true` on the `production` GitHub environment. Unset it or set it to `false` to freeze releases.

**Sign-in policy is committed, not a variable.** Identity is the issuer subject; no address or address domain admits anyone. `api/wrangler.<stage>.jsonc` sets `ACCOUNT_REQUIRED_ACR` (GitHub, Google, email link or password) and `AUTH_STAFF_GOOGLE_DOMAINS` (staff sign-up by the Google Workspace domain of a Google sign-in's provider identity; no other method is ever staff). Everyone else joins by invitation or is bound by subject by an operator (`api/scripts/list-signin-attempts.ts`). The old `AUTH_ALLOWED_EMAILS`/`AUTH_ALLOWED_DOMAINS` GitHub variables are no longer read; delete them, and any Worker secret of those names.

**Local live E2E:** install API and SDK dependencies, build the SDK (`cd sdk && bun run build`), and privately export `NIGHTMAIL_E2E_API_KEY`. From `api/` run:

```sh
NIGHTMAIL_E2E_URL=https://dev.nightmail.dev NIGHTMAIL_E2E_REGION=us-east-2 \
NIGHTMAIL_E2E_DOMAIN=e2e.bane.mx NIGHTMAIL_E2E_DOMAIN_ID=dom_e53755830a0141a5bd6e71e45e942f06 \
NIGHTMAIL_E2E_ALLOW_DESTRUCTIVE=1 bun run e2e
```

This sends real SES simulator and inbound-loop mail and consumes sandbox quota. The destructive opt-in is accepted only on the pinned dev fixture. Omit it for the production-safe subset; never run tests on customer data. Both modes first clean up run-owned fixtures older than 30 minutes from interrupted runs. API keys do not support expiry; normal cleanup and the next run revoke test keys. Inspect `api/e2e-report.json` for operation coverage and request IDs.
