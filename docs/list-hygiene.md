# List hygiene: sources, licenses and checks

List hygiene flags contacts whose address looks like a spam trap or can't reach a person, when a contact is created or
imported and in an hourly pass over every contact (`api/src/list-hygiene.ts`). Campaigns and marketing sends skip a
flagged contact unless its owner allows it; transactional mail is never refused, only warned about.

## Open lists

Synced once a day by the hourly upkeep (`syncHygieneLists`), never at send time. Each source is fetched from GitHub raw
and checked: HTTP 200, a size cap, a floor on its entry count, at least half the entries of its last good copy, well-formed
host names, and no large provider (gmail.com, outlook.com, yahoo.com, icloud.com, proton.me and the like) on a disposable
list. A source that fails keeps its last good copy (`hygiene_lists`, `source:<name>`); one that has never been fetched is
covered by the vendored snapshot, `api/src/hygiene-snapshot.ts`, which is also what an installation uses until its first sync
(or always, with `NIGHTMAIL_HYGIENE_LISTS=off`). A day's change to the built lists is capped: more than 2,000 (or 2%) new
disposable domains or more than 25 (or 1%) providers dropped keeps the last built
lists and logs `HYGIENE_LISTS_CHANGE_REFUSED` until an operator accepts it (`syncHygieneLists(runtime, fetch, true, true)`).
Refresh the snapshot with
`node --import tsx scripts/update-hygiene-snapshot.ts` from `api/`.

Only permissively licensed sources. No GPL list is fetched or vendored.

| Source | License | Used for |
| --- | --- | --- |
| [disposable-email-domains/disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) (`disposable_email_blocklist.conf`) | CC0-1.0 | disposable domains |
| [disposable/disposable-email-domains](https://github.com/disposable/disposable-email-domains) (`domains.txt`; not the strict list, which adds forwarding services) | MIT | disposable domains |
| [7c/fakefilter](https://github.com/7c/fakefilter) (`txt/data.txt`) | BSD-3-Clause | disposable domains |
| [FGRibreau/mailchecker](https://github.com/FGRibreau/mailchecker) (`list.txt`) | MIT | disposable domains |
| [mixmaxhq/role-based-email-addresses](https://github.com/mixmaxhq/role-based-email-addresses) (`src/index.js`) | MIT | role names for list statistics (the soft tier) |
| [tompec/public-email-providers-domains](https://github.com/tompec/public-email-providers-domains) (`data/domains.json`) | MIT | real providers: never disposable |

The disposable list is the union of the four disposable sources, less an allowlist kept in
`api/src/hygiene-sources.ts` (`ALLOWED`: the large providers, privacy relays such as duck.com, Firefox Relay, SimpleLogin
and Proton Pass, and real providers some lists carry), less the providers list, and less the providers in the vendored
snapshot, which stay allowed even if the providers source later drops them. A domain under a listed one
(`sub.mailinator.com`) is disposable too.

Only RFC 2142 and no-reply names (abuse@, postmaster@, noreply@, unsubscribe@ …) make a contact risky (`role`). The synced
role list (info@, sales@ …) only counts in the audience statistics (`api/src/deliverability.ts`).

## Domain checks

Each recipient domain is checked once a day at most, never per address and never over SMTP: one MX query over DNS over
HTTPS (`NIGHTMAIL_HYGIENE_DNS`; Hosted defaults to Cloudflare's resolver, self-hosted installations to none), and an
A/AAAA query when there is no MX (`api/src/mail-dns.ts`). The verdict is cached in `hygiene_mail_domains`.

- **no_mail_domain:** NXDOMAIN, a null MX (`0 .`, RFC 7505), or no MX and no address.
- A shared mail server does not classify its domains as disposable; only the domain lists above do.
- A failed lookup (SERVFAIL, timeout) flags nobody and is retried an hour later. Providers on the lists are never looked up.

A contact created through the API is checked inline (1.5 s at most). An import preview checks its domains for 3 s and
counts the verdicts in its summary; domains it didn't reach are queued, the commit stores what is known by then, and a
resolver job flags the imported contacts as their domains are checked. The hourly pass queues domains it hasn't seen.
