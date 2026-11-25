import { cname, dns, fqdn } from './public-dns.js';
import { placementRoot } from './domain-registry.js';

// What public DNS shows for each record a domain still waits for, so Check now can say which one is missing or
// different, not just that SES hasn't verified yet. SES reports DKIM for the three CNAMEs together; this reads each.
// Cloudflare's resolver (1.1.1.1) over HTTPS, one bounded lookup per record, answers kept for 30 seconds per isolate so
// pressing Check now again and again costs nothing. A record DNS didn't answer for gets publicDns null.

/**
 * wildcard: the name has no record of its own, but a wildcard (`*.<domain>`) answers it, as it answers a random name beside
 * it, or a registrar's parking or forwarding host does. parking: whose (Porkbun) and what it points to (pixie.porkbun.com).
 */
export type PublicDns = { state: 'found' | 'missing' | 'wrong_value'; values: string[]; checkedAt: string; wildcard?: string; parking?: { owner: string; target: string } };
type CheckedRecord = { name: string; type: 'CNAME' | 'TXT' | 'MX'; value: string; purpose: string; status: string; publicDns?: PublicDns | null };

const TTL_MS = 30_000, MAX_ENTRIES = 500, BUDGET_MS = 3_000, MAX_VALUES = 5, MAX_VALUE_LENGTH = 255;
// Plain answers only, never a pending promise: a Worker can't await I/O another request started.
const cache = new Map<string, { at: number; values: string[] }>();

// A TXT answer is one or more quoted strings; receivers read them joined.
const txtText = (data: string) => { const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]!.replace(/\\(.)/g, '$1')); return parts.length ? parts.join('') : data; };
const mxHost = (data: string) => fqdn(data.trim().split(/\s+/).at(-1) ?? '');

async function answer(name: string, type: CheckedRecord['type'] | 'A', signal: AbortSignal) {
  const key = `${type} ${fqdn(name)}`, hit = cache.get(key), now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.values;
  const values = type === 'CNAME' ? await cname(name, signal).then(target => target ? [fqdn(target)] : [])
    : (await dns(name, type, signal)).values.map(type === 'TXT' ? txtText : data => data.trim().replace(/\.$/, '').toLowerCase());
  cache.delete(key); cache.set(key, { at: now, values });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return values;
}

function compare(record: CheckedRecord, values: string[]): Omit<PublicDns, 'checkedAt'> {
  const spf = record.type === 'TXT' && record.value.startsWith('v=spf1');
  // An SPF record that includes amazonses.com does what this one asks, whatever else it allows.
  const relevant = spf ? values.filter(v => v.toLowerCase().startsWith('v=spf1')) : values;
  const matches = (v: string) => record.type === 'TXT' ? v === record.value || (spf && /(^|\s)include:amazonses\.com(\s|$)/i.test(v)) : record.type === 'MX' ? mxHost(v) === fqdn(record.value) : fqdn(v) === fqdn(record.value);
  const shown = relevant.slice(0, MAX_VALUES).map(v => v.slice(0, MAX_VALUE_LENGTH));
  return relevant.some(matches) ? { state: 'found', values: [] } : relevant.length ? { state: 'wrong_value', values: shown } : { state: 'missing', values: [] };
}

// Where a domain's DNS is hosted, from its zone's NS records, so the dashboard and the setup reminder can say where to add
// the records and link that provider's DNS page. Only providers whose nameservers are theirs alone; any other is null.
export type DnsHost = { name: string; zone: string; url: string | null };
const PROVIDERS: [RegExp, string, ((zone: string) => string) | null][] = [
  [/\.ns\.cloudflare\.com$/, 'Cloudflare', zone => `https://dash.cloudflare.com/?to=/:account/${zone}/dns/records`],
  [/\.vercel-dns\.com$/, 'Vercel', () => 'https://vercel.com/dashboard/domains'],
  [/\.awsdns-\d+\.(?:com|net|org|co\.uk)$/, 'Route 53', () => 'https://console.aws.amazon.com/route53/v2/hostedzones'],
  [/\.domaincontrol\.com$/, 'GoDaddy', zone => `https://dcc.godaddy.com/control/portfolio/${zone}/settings?tab=dns`],
  [/\.registrar-servers\.com$/, 'Namecheap', zone => `https://ap.www.namecheap.com/Domains/DomainControlPanel/${zone}/advancedns`],
  [/\.digitalocean\.com$/, 'DigitalOcean', zone => `https://cloud.digitalocean.com/networking/domains/${zone}`],
  [/\.ui-dns\.(?:com|de|org|biz)$/, 'IONOS', null], [/\.porkbun\.com$/, 'Porkbun', null], [/\.hover\.com$/, 'Hover', null],
  [/\.gandi\.net$/, 'Gandi', null], [/\.ovh\.net$/, 'OVHcloud', null], [/\.hetzner\.(?:com|de)$/, 'Hetzner', null],
  [/\.azure-dns\.(?:com|net|org|info)$/, 'Azure DNS', null], [/\.dnsimple\.com$/, 'DNSimple', null], [/\.dreamhost\.com$/, 'DreamHost', null], [/\.name\.com$/, 'Name.com', null],
];
const HOST_TTL_MS = 30 * 60_000;
export type DnsZone = { host: DnsHost | null; noDns: boolean };
const hostCache = new Map<string, { at: number } & DnsZone>();
/**
 * The zone that answers for `name`: the NS records at the name, or at the zone its SOA names. `host`: its provider, null
 * when unknown. `noDns`, only on a definitive answer: no nameservers serve the name's own registered domain, because the
 * closest zone DNS knows is its top-level domain or public suffix (acme.co → co, acme.co.uk → co.uk), or there is none.
 * A subdomain that has no records yet (mail.acme.com under a served acme.com) has DNS. Resolver errors and timeouts throw:
 * callers treat them as unknown, never as no DNS.
 */
export async function dnsZone(name: string, signal: AbortSignal): Promise<DnsZone> {
  const key = fqdn(name), hit = hostCache.get(key);
  if (hit && Date.now() - hit.at < HOST_TTL_MS) return { host: hit.host, noDns: hit.noDns };
  let zone = key, answer = await dns(zone, 'NS', signal);
  const soa = answer.values.length ? '' : fqdn(answer.authority.find(r => r.type === 6)?.name ?? '');
  if (soa.includes('.') && key.endsWith(`.${soa}`)) { zone = soa; answer = await dns(zone, 'NS', signal); }
  const servers = answer.values.map(fqdn), found = PROVIDERS.find(([pattern]) => servers.length > 0 && servers.every(server => pattern.test(server)));
  const host = found ? { name: found[1], zone, url: found[2]?.(zone) ?? null } : null;
  // Served, but by a zone above the name's registered domain (a public suffix such as co.uk): nobody serves the domain.
  const root = servers.length && zone !== key ? await placementRoot(key).catch(() => null) : null;
  const noDns = servers.length ? !!root?.known && !!root.root && root.root !== zone && root.root.endsWith(`.${zone}`)
    : answer.status === 3 || !!soa;
  hostCache.delete(key); hostCache.set(key, { at: Date.now(), host, noDns });
  while (hostCache.size > MAX_ENTRIES) hostCache.delete(hostCache.keys().next().value!);
  return { host, noDns };
}
/** One bounded lookup when a domain is added: whether anyone serves DNS for it. Never throws; unknown is false. */
export const noDnsAt = (name: string, timeoutMs = 2_000) => dnsZone(name, AbortSignal.timeout(timeoutMs)).then(zone => zone.noDns, () => false);

const sameSet = (a: string[], b: string[]) => a.length > 0 && a.length === b.length && a.every(v => b.includes(v));
// Registrars' parking and forwarding hosts, which a new domain's defaults point every name at (often through a *
// record): a CNAME target, or the address it answers with.
const PARKING: [RegExp, string][] = [
  [/(?:^|\.)(?:pixie|uixie)\.porkbun\.com$/, 'Porkbun'],
  [/(?:^|\.)parkingpage\.godaddy\.com$/, 'GoDaddy'], [/^(?:34\.102\.136\.180|3\.33\.152\.147|15\.197\.142\.173)$/, 'GoDaddy'],
  [/(?:^|\.)parkingpage\.namecheap\.com$/, 'Namecheap'],
  [/(?:^|\.)ext-(?:sq|cust)\.squarespace\.com$/, 'Squarespace'], [/^(?:198\.185\.159\.14[45]|198\.49\.23\.14[45])$/, 'Squarespace'],
];
const parkingOwner = (value: string) => PARKING.find(([pattern]) => pattern.test(fqdn(value)))?.[1];
// Cloudflare's proxy addresses (its published IPv4 ranges): a proxied record answers with these, never the CNAME behind it.
const CLOUDFLARE = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const ipv4 = (ip: string) => { const parts = ip.split('.').map(Number); return parts.length === 4 && parts.every(p => Number.isInteger(p) && p >= 0 && p <= 255) ? parts.reduce((n, p) => n * 256 + p, 0) : null; };
const cloudflareProxy = (ip: string) => { const n = ipv4(ip); return n !== null && CLOUDFLARE.some(range => { const [base, bits] = range.split('/'); const size = 2 ** (32 - Number(bits)); return Math.floor(n / size) === Math.floor(ipv4(base!)! / size); }); };
/**
 * A CNAME the domain hasn't published, whose name something else answers anyway: a wildcard (`*.<domain>`) that answers a
 * random name beside it the same way (Cloudflare's proxied `*` record; a registrar's `* CNAME` parking default), or a known
 * parking or forwarding host. It still has to be added: any exact record wins over the wildcard. Undefined when neither.
 * `seen`: what the CNAME lookup found (a different target is a parking or wildcard CNAME, not a typo, when this matches).
 */
async function wildcardFor(name: string, domain: string, seen: { state: string; values: string[] }, sibling: (parent: string, type: 'A' | 'CNAME') => Promise<string[]>, signal: AbortSignal) {
  const parent = name.slice(name.indexOf('.') + 1), wildcard = `*.${domain}`;
  const [type, values] = seen.state === 'wrong_value' ? ['CNAME' as const, seen.values.map(fqdn)] : ['A' as const, await answer(name, 'A', signal)];
  if (!values.length) return undefined;
  const owner = values.map(parkingOwner).find(Boolean), target = values[0]!;
  if (owner) return { wildcard, parking: { owner, target } };
  if (type === 'A' && values.every(cloudflareProxy)) return { wildcard };
  return sameSet(values, (await sibling(parent, type)).map(fqdn)) ? { wildcard } : undefined;
}
/** Adds publicDns to every pending sending, link and MAIL FROM record (DMARC is a recommendation; receiving has its own MX check). */
export async function withPublicDns<T extends { name?: string; dns: CheckedRecord[] }>(report: T): Promise<T> {
  const signal = AbortSignal.timeout(BUDGET_MS), checkedAt = new Date().toISOString();
  // One random name per parent (e.g. _domainkey.<domain>), asked once however many CNAMEs share it.
  const siblings = new Map<string, Promise<string[]>>(), label = `nm-${crypto.randomUUID().slice(0, 12)}`;
  const sibling = (parent: string, type: 'A' | 'CNAME') => { const key = `${type} ${parent}`; let probe = siblings.get(key); if (!probe) siblings.set(key, probe = answer(`${label}.${parent}`, type, signal)); return probe; };
  await Promise.all(report.dns.map(async record => {
    if (record.status === 'verified' || (record.purpose !== 'sending' && record.purpose !== 'links' && record.purpose !== 'mail_from')) return;
    try {
      const seen = compare(record, await answer(record.name, record.type, signal));
      const found = seen.state !== 'found' && record.type === 'CNAME' ? await wildcardFor(fqdn(record.name), fqdn(report.name ?? record.name.split('.').slice(-2).join('.')), seen, sibling, signal).catch(() => undefined) : undefined;
      // Answered by a wildcard or a parking host, the record is missing, not mistyped: "wrong value" would read as a typo.
      record.publicDns = found ? { state: 'missing', values: [], checkedAt, ...found } : { ...seen, checkedAt };
    }
    catch { record.publicDns = null; }
  }));
  return report;
}
/** The wildcard (and parking host) answering for a domain's missing CNAMEs, if one does (withPublicDns); dns-messages.ts words it. */
export const wildcardOf = (records: { publicDns?: PublicDns | null }[]) => {
  const seen = records.find(r => r.publicDns?.state === 'missing' && r.publicDns.wildcard)?.publicDns;
  return seen?.wildcard ? { wildcard: seen.wildcard, ...(seen.parking ? { parking: seen.parking } : {}) } : undefined;
};

/**
 * A pending domain's DNS as the background check saw it (domain_claims.setup_check): each pending record's publicDns
 * and where the zone is hosted. Reads show it until the next check (src/domain-setup.ts), so no read asks DNS itself.
 */
export type SetupCheck = { checkedAt: string; host: DnsHost | null; /** Nobody serves DNS for the domain (dnsZone). */ noDns?: boolean; records: { type: string; name: string; value: string; publicDns: PublicDns | null }[] };
/** withPublicDns and dnsHost together, within the same three seconds: the report gains publicDns, the answer is what to store. */
export async function checkSetup<T extends { name: string; dns: CheckedRecord[] }>(report: T): Promise<SetupCheck> {
  // A domain with nothing left to publish needs no host either.
  const waiting = report.dns.some(r => r.status !== 'verified' && (r.purpose === 'sending' || r.purpose === 'mail_from'));
  const [, zone] = await Promise.all([withPublicDns(report), waiting ? dnsZone(report.name, AbortSignal.timeout(BUDGET_MS)).catch(() => null) : null]);
  return { checkedAt: new Date().toISOString(), host: zone?.host ?? null, ...(zone?.noDns ? { noDns: true } : {}), records: report.dns.flatMap(r => r.publicDns === undefined ? [] : [{ type: r.type, name: r.name, value: r.value, publicDns: r.publicDns }]) };
}
