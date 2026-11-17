#!/usr/bin/env bash
set -euo pipefail
# The name is looked up over DNS-over-HTTPS, not the runner's resolver: a deploy that has just attached a new custom
# domain is checked seconds later, and a resolver that asked before the record existed keeps answering "no such host"
# for the zone's negative TTL (the Nov 17 dev.nightmail.dev deploy failed three attempts that way). Every error retries.
for origin in "$@"; do
  curl --fail --silent --show-error --max-time 10 --retry 36 --retry-delay 10 --retry-all-errors --doh-url https://cloudflare-dns.com/dns-query "$origin/health" |
    jq -e '.status == "ok" and (.service == "nightmail" or .service == "bane" or .service == "opensend") and .multiTenant == true' || { echo "Invalid or unavailable $origin/health" >&2; exit 1; }
done
