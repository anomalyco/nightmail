import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { Alert } from '../../components/ui'
import type { DnsRecord, Domain, PublicDns } from '../../data/types'
import { wildcardMessage, type WildcardSeen } from '../../../../api/src/dns-messages'
import './domain-setup-alert.css'

// The banner for a domain still pending an hour after it was added whose records public DNS lacks: how many of the records
// verification waits for (the ownership TXT and the DKIM CNAMEs) are missing, where the domain's DNS is hosted and a link
// to that provider's DNS page. The API's background check (src/domain-setup.ts) stores what it saw, and domain reads carry
// it (dns[].publicDns, dnsHost), so the banner is there from the first frame; the setup reminder email says the same.
// Small on purpose, without the records page's styles: Overview shows it too.

/** What Check now found, by record (the domain page keeps it while it polls). */
export type DnsChecks = Map<string, PublicDns | null>
export const checkKey = (record: Pick<DnsRecord, 'type' | 'name' | 'value'>) => `${record.type} ${record.name} ${record.value}`
/** noDns: nobody serves DNS for the domain (Domain.dnsIssue), so no record can be published: its name needs checking. */
/** wildcard: a wildcard record (*.domain) answers the missing CNAMEs' names with an address. */
export type SetupGap = { missing: number; total: number; wrong: boolean; host: NonNullable<Domain['dnsHost']> | null; noDns?: true; wildcard?: WildcardSeen }

/**
 * The records verification waits for that DNS lacks or has with another value, or null: nothing missing, a domain that
 * verified, or one the background check doesn't follow (dnsHost is absent on reads until it does). `checks`, from a
 * Check now on the domain page, are fresher than the stored answers.
 */
export function setupGap(domain: Domain, checks?: DnsChecks): SetupGap | null {
  if (domain.status === 'verified' || domain.sending === 'verified') return null
  const records = domain.records.filter(record => record.purpose === 'sending')
  // Set from the moment the domain is added (the API's NS lookup), before any background check.
  if (domain.dnsIssue?.code === 'no_dns') return { missing: records.length, total: records.length, wrong: false, host: null, noDns: true }
  if (domain.dnsHost === undefined) return null
  const state = (record: DnsRecord) => (checks?.has(checkKey(record)) ? checks.get(checkKey(record)) : record.publicDns)?.state
  const missing = records.filter(record => record.status !== 'verified' && (state(record) === 'missing' || state(record) === 'wrong_value'))
  const seen = (record: DnsRecord) => checks?.has(checkKey(record)) ? checks.get(checkKey(record)) : record.publicDns
  const answered = missing.map(seen).find(found => found?.state === 'missing' && found.wildcard)
  const wildcard: WildcardSeen | undefined = answered?.wildcard ? { wildcard: answered.wildcard, ...(answered.parking ? { parking: answered.parking } : {}) } : undefined
  return missing.length ? { missing: missing.length, total: records.length, wrong: missing.some(record => state(record) === 'wrong_value'), host: domain.dnsHost, ...(wildcard ? { wildcard } : {}) } : null
}

export const gapTitle = ({ missing, total, wrong, host }: SetupGap) => `${missing} of ${total} ${total === 1 ? 'record' : 'records'} ${wrong ? 'missing or wrong' : 'missing'}${host ? ` at ${host.name}` : ''}`

/**
 * Every record verification waits for is in public DNS, yet the domain is still pending: Amazon SES checks DNS on its own
 * schedule (it last looked before the records were there), and nothing can make it look sooner. Said so, the page doesn't
 * look stuck. From Check now's answers, or the background check's.
 */
export function recordsCorrect(domain: Domain, checks?: DnsChecks) {
  if (domain.status === 'verified' || domain.sending === 'verified' || domain.dnsIssue) return false
  const waiting = domain.records.filter(record => record.purpose === 'sending' && record.status !== 'verified')
  const state = (record: DnsRecord) => (checks?.has(checkKey(record)) ? checks.get(checkKey(record)) : record.publicDns)?.state
  return waiting.length > 0 && waiting.every(record => state(record) === 'found')
}
export const RECORDS_CORRECT = 'Amazon is finishing verification, which usually takes under an hour.'
export function RecordsCorrectAlert() {
  return <Alert tone="info" title="Your records are correct" data-records-correct="">{RECORDS_CORRECT}</Alert>
}

/** `page`: on the domain's own page, which lists the records; elsewhere it links there. `actions`: the page's own (change the name, delete). */
export function DomainSetupAlert({ domain, gap, page = false, actions }: { domain: Domain; gap: SetupGap; page?: boolean; actions?: ReactNode }) {
  if (gap.noDns) return <Alert tone="danger" title={`No DNS found for ${domain.name}`} data-domain-setup="" data-no-dns="">
    {page ? 'Check the spelling, or that the domain is registered.' : `Check the spelling, or that the domain is registered: mail from ${domain.name} can’t be sent until it has DNS.`}
    {page ? actions && <span className="domain-setup-links">{actions}</span> : <span className="domain-setup-links"><Link to={`/domains/${domain.id}`}>Open the domain</Link></span>}
  </Alert>
  const one = gap.missing === 1, where = gap.host ? `at ${gap.host.name}` : 'where your DNS is hosted'
  return <Alert tone="warning" title={page ? gapTitle(gap) : `${domain.name}: ${gapTitle(gap)}`} data-domain-setup="">
    {page ? (gap.wildcard ? `${wildcardMessage(gap.wildcard, gap.host?.name)} Then press Check now.` : `Add ${one ? 'it' : 'them'} ${where}, then press Check now.`)
      : `Mail from ${domain.name} can’t be sent until ${one ? 'it is' : 'they are'} published ${where}.${gap.wildcard ? ` ${wildcardMessage(gap.wildcard, gap.host?.name)}` : ''}`}
    {(!page || gap.host?.url) && <span className="domain-setup-links">
      {!page && <Link to={`/domains/${domain.id}`}>View records</Link>}
      {gap.host?.url && <a href={gap.host.url} target="_blank" rel="noreferrer">Open {gap.host.name} DNS<ArrowUpRight size={14} aria-hidden /></a>}
    </span>}
  </Alert>
}
