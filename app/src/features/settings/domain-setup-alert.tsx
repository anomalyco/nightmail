import { Link } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { Alert } from '../../components/ui'
import type { DnsRecord, Domain, PublicDns } from '../../data/types'
import './domain-setup-alert.css'

// The banner for a domain still pending an hour after it was added whose records public DNS lacks: how many of the records
// verification waits for (the ownership TXT and the DKIM CNAMEs) are missing, where the domain's DNS is hosted and a link
// to that provider's DNS page. The API's background check (src/domain-setup.ts) stores what it saw, and domain reads carry
// it (dns[].publicDns, dnsHost), so the banner is there from the first frame; the setup reminder email says the same.
// Small on purpose, without the records page's styles: Overview shows it too.

/** What Check now found, by record (the domain page keeps it while it polls). */
export type DnsChecks = Map<string, PublicDns | null>
export const checkKey = (record: Pick<DnsRecord, 'type' | 'name' | 'value'>) => `${record.type} ${record.name} ${record.value}`
export type SetupGap = { missing: number; total: number; wrong: boolean; host: NonNullable<Domain['dnsHost']> | null }

/**
 * The records verification waits for that DNS lacks or has with another value, or null: nothing missing, a domain that
 * verified, or one the background check doesn't follow (dnsHost is absent on reads until it does). `checks`, from a
 * Check now on the domain page, are fresher than the stored answers.
 */
export function setupGap(domain: Domain, checks?: DnsChecks): SetupGap | null {
  if (domain.dnsHost === undefined || domain.status === 'verified' || domain.sending === 'verified') return null
  const records = domain.records.filter(record => record.purpose === 'sending')
  const state = (record: DnsRecord) => (checks?.has(checkKey(record)) ? checks.get(checkKey(record)) : record.publicDns)?.state
  const missing = records.filter(record => record.status !== 'verified' && (state(record) === 'missing' || state(record) === 'wrong_value'))
  return missing.length ? { missing: missing.length, total: records.length, wrong: missing.some(record => state(record) === 'wrong_value'), host: domain.dnsHost } : null
}

export const gapTitle = ({ missing, total, wrong, host }: SetupGap) => `${missing} of ${total} ${total === 1 ? 'record' : 'records'} ${wrong ? 'missing or wrong' : 'missing'}${host ? ` at ${host.name}` : ''}`

/** `page`: on the domain's own page, which lists the records; elsewhere it links there. */
export function DomainSetupAlert({ domain, gap, page = false }: { domain: Domain; gap: SetupGap; page?: boolean }) {
  const one = gap.missing === 1, where = gap.host ? `at ${gap.host.name}` : 'where your DNS is hosted'
  return <Alert tone="warning" title={page ? gapTitle(gap) : `${domain.name}: ${gapTitle(gap)}`} data-domain-setup="">
    {page ? `Public DNS doesn’t have ${one ? 'it' : 'them'} yet, so mail from ${domain.name} can’t be sent. Add ${one ? 'it' : 'them'} ${where}, then press Check now.`
      : `Mail from ${domain.name} can’t be sent until ${one ? 'it is' : 'they are'} published ${where}.`}
    {(!page || gap.host?.url) && <span className="domain-setup-links">
      {!page && <Link to={`/domains/${domain.id}`}>View records</Link>}
      {gap.host?.url && <a href={gap.host.url} target="_blank" rel="noreferrer">Open {gap.host.name} DNS<ArrowUpRight size={14} aria-hidden /></a>}
    </span>}
  </Alert>
}
