// The open lists list hygiene is built from (docs/list-hygiene.md), each with its license. Only permissive licenses (CC0,
// MIT, BSD-3-Clause): no GPL list is fetched or vendored. Fetched from GitHub raw by the nightly sync (syncHygieneLists in
// list-hygiene.ts) and by scripts/update-hygiene-snapshot.ts, which writes the vendored fallback (generated/hygiene-snapshot.json).
// Never fetched at send time.
import { createHash } from 'node:crypto';

export type SourceKind = 'disposable' | 'providers' | 'roles';
export type Source = { name: string; repository: string; license: 'CC0-1.0' | 'MIT' | 'BSD-3-Clause'; kind: SourceKind; url: string;
  /** Fewer entries than this is a broken fetch, not a smaller list. */ min: number; maxBytes: number; parse(text: string): Parsed };
export type Parsed = { entries: string[]; mx?: string[] };

const NAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const lines = (text: string): Parsed => ({ entries: text.split('\n').map(l => l.trim().toLowerCase()).filter(l => l && !l.startsWith('#')) });
const raw = (repo: string, ref: string, path: string) => `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
const MiB = 1024 * 1024;
export const SOURCES: readonly Source[] = [
  { name: 'disposable-email-domains', repository: 'https://github.com/disposable-email-domains/disposable-email-domains', license: 'CC0-1.0', kind: 'disposable',
    url: raw('disposable-email-domains/disposable-email-domains', 'main', 'disposable_email_blocklist.conf'), min: 5_000, maxBytes: 4 * MiB, parse: lines },
  // domains.txt only: domains_strict.txt adds anonymous freemail and forwarding services.
  { name: 'disposable', repository: 'https://github.com/disposable/disposable-email-domains', license: 'MIT', kind: 'disposable',
    url: raw('disposable/disposable-email-domains', 'master', 'domains.txt'), min: 50_000, maxBytes: 16 * MiB, parse: lines },
  { name: 'fakefilter', repository: 'https://github.com/7c/fakefilter', license: 'BSD-3-Clause', kind: 'disposable',
    url: raw('7c/fakefilter', 'main', 'txt/data.txt'), min: 2_000, maxBytes: 4 * MiB, parse: lines },
  { name: 'mailchecker', repository: 'https://github.com/FGRibreau/mailchecker', license: 'MIT', kind: 'disposable',
    url: raw('FGRibreau/mailchecker', 'master', 'list.txt'), min: 20_000, maxBytes: 8 * MiB, parse: lines },
  // A JavaScript module of string arrays: every quoted entry is a role local part (info, sales, …). The soft tier, for
  // list statistics: only RFC 2142 and no-reply names make a contact risky (ROLES in list-hygiene.ts).
  { name: 'role-based-email-addresses', repository: 'https://github.com/mixmaxhq/role-based-email-addresses', license: 'MIT', kind: 'roles',
    url: raw('mixmaxhq/role-based-email-addresses', 'master', 'src/index.js'), min: 200, maxBytes: 1 * MiB,
    parse: text => ({ entries: [...text.matchAll(/'([a-z0-9][a-z0-9._+-]{0,63})'/g)].map(m => m[1]!) }) },
  // A curated list of real mailbox providers with their MX hosts: never disposable, and their MX hosts never count as a
  // disposable service's.
  { name: 'public-email-providers-domains', repository: 'https://github.com/tompec/public-email-providers-domains', license: 'MIT', kind: 'providers',
    url: raw('tompec/public-email-providers-domains', 'main', 'data/domains.json'), min: 500, maxBytes: 8 * MiB,
    parse: text => {
      const entries: string[] = [], mx: string[] = [];
      for (const provider of JSON.parse(text) as { domains?: { domain?: string; mxRecords?: { hostname?: string }[] }[] }[])
        for (const d of provider.domains ?? []) { if (d.domain) entries.push(d.domain.toLowerCase()); for (const m of d.mxRecords ?? []) if (m.hostname) mx.push(m.hostname.toLowerCase().replace(/\.$/, '')); }
      return { entries, mx };
    } },
];

// Never disposable, whatever a list says: the large providers (a list that carries one of these is broken or poisoned,
// and its fetch is refused), and privacy relays and real providers a list carries that forward to or are a real person's
// mailbox (duck.com, Firefox Relay, SimpleLogin, Proton Pass; nus.edu.sg). The providers list is added to it.
export const NEVER_LISTED = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'protonmail.com', 'proton.me'];
export const ALLOWED = new Set([...NEVER_LISTED, ...`duck.com mozmail.com relay.firefox.com privaterelay.appleid.com simplelogin.com simplelogin.co simplelogin.fr slmail.me
  slmails.com aleeas.com 8shield.net 8alias.com dralias.com silomails.com anonaddy.com anonaddy.me addy.io passmail.com passmail.net passinbox.com passfwd.com
  33mail.com burnermail.io spamgourmet.com spamgourmet.net spamgourmet.org erine.email maskmy.id forwardemail.net sneakemail.com snkmail.com snkml.com
  keemail.me tutanota.com tutanota.de tuta.com tuta.io tutamail.com hush.com hush.ai mac.hush.com lavabit.com nus.edu.sg tom.com 21cn.com test.de vfemail.net
  safe-mail.net sibmail.com mail2world.com e-mail.net airmail.cc firemail.cc cock.li`.split(/\s+/)]);

export type FetchedSource = { name: string; entries: string[]; mx?: string[]; sha256: string; bytes: number; fetchedAt: string };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/**
 * One source, checked: HTTP 200, at most maxBytes, at least min entries and half its previous count (a list doesn't halve
 * overnight), every entry a host name (or a local part, for roles), and no disposable list carrying a large provider.
 * Throws a plain message otherwise: the caller keeps the source's last good copy.
 */
export async function fetchSource(source: Source, previousCount: number | null, fetcher: typeof fetch = fetch): Promise<FetchedSource> {
  const response = await fetcher(source.url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'text/plain, application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > source.maxBytes) throw new Error(`${declared} bytes is over ${source.maxBytes}`);
  const text = await response.text();
  if (text.length > source.maxBytes) throw new Error(`${text.length} bytes is over ${source.maxBytes}`);
  const parsed = source.parse(text);
  const valid = source.kind === 'roles' ? (e: string) => /^[a-z0-9][a-z0-9._+-]{0,63}$/.test(e) : (e: string) => NAME.test(e);
  const unique = [...new Set(parsed.entries)], entries = unique.filter(valid).sort();
  if (entries.length < source.min) throw new Error(`${entries.length} entries is under the floor of ${source.min}`);
  if (previousCount && entries.length < previousCount / 2) throw new Error(`${entries.length} entries is under half the last copy's ${previousCount}`);
  if (unique.length - entries.length > Math.max(50, unique.length * 0.01)) throw new Error(`${unique.length - entries.length} malformed entries`);
  if (source.kind === 'disposable') { const listed = NEVER_LISTED.filter(d => entries.includes(d)); if (listed.length) throw new Error(`it lists ${listed.join(', ')}`); }
  return { name: source.name, entries, ...parsed.mx ? { mx: [...new Set(parsed.mx)].filter(h => NAME.test(h)).sort() } : {}, sha256: sha(text), bytes: text.length, fetchedAt: new Date().toISOString() };
}

export type BuiltLists = { version: string; builtAt: string; disposable: string; providers: string[]; providerMx: string[]; roles: string[];
  sources: { name: string; license: string; repository: string; count: number; sha256: string; fetchedAt: string }[] };
/** The union of the disposable sources less the allowlist and the providers, sorted; the providers, their MX hosts and the roles.
 *  `alwaysAllowed`: providers that stay off the disposable list whatever the providers source says now (the snapshot's). */
export function buildLists(fetched: FetchedSource[], alwaysAllowed: Iterable<string> = []): BuiltLists {
  const by = (kind: SourceKind) => fetched.filter(f => SOURCES.find(s => s.name === f.name)?.kind === kind);
  const providers = [...new Set(by('providers').flatMap(f => f.entries))].sort();
  const allowed = new Set([...ALLOWED, ...alwaysAllowed, ...providers]);
  const disposable = [...new Set(by('disposable').flatMap(f => f.entries))].filter(d => !allowed.has(d)).sort();
  const roles = [...new Set(by('roles').flatMap(f => f.entries))].sort();
  const providerMx = [...new Set(by('providers').flatMap(f => f.mx ?? []))].sort();
  const body = disposable.join('\n');
  const version = sha([body, providers.join('\n'), roles.join('\n'), [...allowed].sort().join('\n')].join('\u0000')).slice(0, 16);
  return { version, builtAt: new Date().toISOString(), disposable: body, providers, providerMx, roles,
    sources: fetched.map(f => { const s = SOURCES.find(x => x.name === f.name)!; return { name: f.name, license: s.license, repository: s.repository, count: f.entries.length, sha256: f.sha256, fetchedAt: f.fetchedAt }; }) };
}
