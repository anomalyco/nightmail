import type { Contact, RiskReason } from '../../data/types'

// The API's contact states, in the order a marketer meets them, then Risky: contacts campaigns skip for their address
// alone (list hygiene) until someone allows them.
export const statusOptions = [{ value: 'subscribed', label: 'Subscribed' }, { value: 'unknown', label: 'Unknown' }, { value: 'unsubscribed', label: 'Unsubscribed' }, { value: 'suppressed', label: 'Suppressed' }, { value: 'risky', label: 'Risky' }]
// A contacts or list filter on Unknown with nobody in it.
export const noUnknown = 'No one with unknown consent'
export const evidenceRequired = 'Say how they agreed, e.g. “Signed up on our website”.'
const legend: Record<string, string> = { subscribed: 'can receive campaigns', unknown: 'no recorded consent; campaigns skip them', suppressed: 'bounced, complained or blocked; gets no email at all', risky: 'the address looks unsafe to mail; campaigns skip them' }
export const consentTitle = (status: string) => {
  const label = statusOptions.find(option => option.value === status)?.label ?? status
  return legend[status] ? `${label}: ${legend[status]}` : label
}

// Why list hygiene flagged an address, as a status (riskLabels) and as a count's noun (riskWords: "290 mistyped").
export const riskLabels: Record<RiskReason, string> = { invalid: 'Invalid address', disposable: 'Disposable domain', typo_domain: 'Mistyped domain', role: 'Role address', dead: 'Undeliverable', no_mail_domain: 'No mail server' }
const riskWords: Record<RiskReason, string> = { invalid: 'invalid', disposable: 'disposable', typo_domain: 'mistyped', role: 'role', dead: 'undeliverable', no_mail_domain: 'with no mail server' }
const riskOrder = Object.keys(riskLabels) as RiskReason[]
/** "3,100 disposable, 290 mistyped, 22 role": the reasons with a count, largest first. */
export const riskBreakdown = (byReason: Partial<Record<RiskReason, number>> | undefined, format: (count: number) => string) =>
  riskOrder.filter(reason => (byReason?.[reason] ?? 0) > 0).sort((a, b) => byReason![b]! - byReason![a]!).map(reason => `${format(byReason![reason]!)} ${riskWords[reason]}`).join(', ')
/** A contact campaigns skip for its address: flagged, and nobody allowed it. */
export const riskSkipped = (contact: Pick<Contact, 'risk'>) => Boolean(contact.risk && !contact.risk.allowed)
/** The status a contact shows: suppressed first, then risky, then its consent. */
export const displayStatus = (contact: Pick<Contact, 'status' | 'risk'>) => contact.status !== 'suppressed' && riskSkipped(contact) ? 'risky' : contact.status
export const statusTitle = (contact: Pick<Contact, 'status' | 'risk'>) => displayStatus(contact) === 'risky' ? `Risky: ${riskLabels[contact.risk!.reason].toLowerCase()}; campaigns skip them` : consentTitle(contact.status)
