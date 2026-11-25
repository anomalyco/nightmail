import { cname, dns, fqdn } from './public-dns.js';

// What public DNS shows for each record a domain still waits for, so Check now can say which one is missing or
// different, not just that SES hasn't verified yet. SES reports DKIM for the three CNAMEs together; this reads each.
// Cloudflare's resolver (1.1.1.1) over HTTPS, one bounded lookup per record, answers kept for 30 seconds per isolate so
// pressing Check now again and again costs nothing. A record DNS didn't answer for gets publicDns null.

export type PublicDns = { state: 'found' | 'missing' | 'wrong_value'; values: string[]; checkedAt: string };
type CheckedRecord = { name: string; type: 'CNAME' | 'TXT' | 'MX'; value: string; purpose: string; status: string; publicDns?: PublicDns | null };

const TTL_MS = 30_000, MAX_ENTRIES = 500, BUDGET_MS = 3_000, MAX_VALUES = 5, MAX_VALUE_LENGTH = 255;
// Plain answers only, never a pending promise: a Worker can't await I/O another request started.
const cache = new Map<string, { at: number; values: string[] }>();

// A TXT answer is one or more quoted strings; receivers read them joined.
const txtText = (data: string) => { const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]!.replace(/\\(.)/g, '$1')); return parts.length ? parts.join('') : data; };
const mxHost = (data: string) => fqdn(data.trim().split(/\s+/).at(-1) ?? '');

async function answer(name: string, type: CheckedRecord['type'], signal: AbortSignal) {
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
  [/\.azure-dns\.(?:com|net|org|info)$/, 'Azure DNS', null], [/\.dnsimple\.com$/, 'DNSimple', null], [/\.name\.com$/, 'Name.com', null],
];
const HOST_TTL_MS = 30 * 60_000;
const hostCache = new Map<string, { at: number; host: DnsHost | null }>();
/** The provider that answers for `name`'s zone: the NS records at the name, or at the zone its SOA names. Null when unknown. */
export async function dnsHost(name: string, signal: AbortSignal): Promise<DnsHost | null> {
  const key = fqdn(name), hit = hostCache.get(key);
  if (hit && Date.now() - hit.at < HOST_TTL_MS) return hit.host;
  let zone = key, answer = await dns(zone, 'NS', signal);
  const soa = answer.values.length ? '' : fqdn(answer.authority.find(r => r.type === 6)?.name ?? '');
  if (soa.includes('.') && key.endsWith(`.${soa}`)) { zone = soa; answer = await dns(zone, 'NS', signal); }
  const servers = answer.values.map(fqdn), found = PROVIDERS.find(([pattern]) => servers.length > 0 && servers.every(server => pattern.test(server)));
  const host = found ? { name: found[1], zone, url: found[2]?.(zone) ?? null } : null;
  hostCache.delete(key); hostCache.set(key, { at: Date.now(), host });
  while (hostCache.size > MAX_ENTRIES) hostCache.delete(hostCache.keys().next().value!);
  return host;
}

/** Adds publicDns to every pending sending and MAIL FROM record (DMARC is a recommendation; receiving has its own MX check). */
export async function withPublicDns<T extends { dns: CheckedRecord[] }>(report: T): Promise<T> {
  const signal = AbortSignal.timeout(BUDGET_MS), checkedAt = new Date().toISOString();
  await Promise.all(report.dns.map(async record => {
    if (record.status === 'verified' || (record.purpose !== 'sending' && record.purpose !== 'mail_from')) return;
    try { record.publicDns = { ...compare(record, await answer(record.name, record.type, signal)), checkedAt }; }
    catch { record.publicDns = null; }
  }));
  return report;
}

/**
 * A pending domain's DNS as the background check saw it (domain_claims.setup_check): each pending record's publicDns
 * and where the zone is hosted. Reads show it until the next check (src/domain-setup.ts), so no read asks DNS itself.
 */
export type SetupCheck = { checkedAt: string; host: DnsHost | null; records: { type: string; name: string; value: string; publicDns: PublicDns | null }[] };
/** withPublicDns and dnsHost together, within the same three seconds: the report gains publicDns, the answer is what to store. */
export async function checkSetup<T extends { name: string; dns: CheckedRecord[] }>(report: T): Promise<SetupCheck> {
  // A domain with nothing left to publish needs no host either.
  const waiting = report.dns.some(r => r.status !== 'verified' && (r.purpose === 'sending' || r.purpose === 'mail_from'));
  const [, host] = await Promise.all([withPublicDns(report), waiting ? dnsHost(report.name, AbortSignal.timeout(BUDGET_MS)).catch(() => null) : null]);
  return { checkedAt: new Date().toISOString(), host, records: report.dns.flatMap(r => r.publicDns === undefined ? [] : [{ type: r.type, name: r.name, value: r.value, publicDns: r.publicDns }]) };
}
