import { productName } from '../../../../api/src/brand'
import { number } from '../../lib/format'
import type { BuiltinDomain, Domain } from '../../data/types'

// The workspace's built-in domain (GET /v1/me connection.builtinDomain): a subdomain of the installation's own domain that
// sends and receives with no DNS, until a domain of the workspace's own verifies. These are its words, said the same
// way in Domains, onboarding and Overview.

/** Who it sends to and how many. Members only, it also says how to email anyone else. */
export function builtinSending(builtin: Pick<BuiltinDomain, 'scope' | 'perDay'>) {
  return builtin.scope === 'members'
    ? `For now it sends only to your workspace members’ own sign-in addresses, up to ${number(builtin.perDay)} a day.`
    : `It sends to anyone, up to ${number(builtin.perDay)} recipients a day.`
}
/** What it does now, for its page and Overview. */
export function builtinStatus(builtin: BuiltinDomain) {
  switch (builtin.sending) {
    case 'closed': return 'Your own domain is verified, so this one only receives now.'
    case 'off': return builtin.paused
      ? `Sending from built-in domains is paused for every workspace while ${productName} looks into a delivery problem. Email that was still queued from this one when it paused was canceled. It keeps receiving.`
      : `${productName} turned this domain off.`
    case 'pending': return 'Getting it ready: usually under a minute.'
    default: return builtinSending(builtin)
  }
}
/** Whether the workspace sends from its built-in domain (or will, once it is set up): its daily cap is the one that applies then. */
export const sendsFromBuiltin = (builtin: BuiltinDomain | null | undefined): builtin is BuiltinDomain => builtin?.sending === 'ready' || builtin?.sending === 'pending'
/** Built-in first: it is the workspace's first domain wherever domains are listed. */
export const builtinFirst = (domains: Domain[]) => [...domains].sort((a, b) => Number(!!b.builtIn) - Number(!!a.builtIn))

export function BuiltinBadge() {
  return <span className="domain-badge" title={`Set up by ${productName}. It needs no DNS and can’t be deleted.`}>Built-in</span>
}
