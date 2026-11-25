import { useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, X } from 'lucide-react'
import { Button, IconButton } from '../../components/ui'
import { useSession, useWorkspaceAccess } from '../../data/context'
import { setDomainStep } from '../../data/onboarding'
import { productName } from '../../../../api/src/brand'
import { SelfTest } from '../docs/first-send'
import { resourceOf } from '../../data/invalidation'
import './no-domain.css'

// Overview's first card while a hosted workspace has no domain at all, whether its owner skipped onboarding's domain step
// or left before it: sending needs one, so the card asks for it and opens that step in one click. It is decided from the
// session's own domain count (GET /v1/me), so it is there from the first frame and nothing moves. Dismissed, it stays away
// for a day in this browser, then comes back while there is still no domain. The API's no-domain email says the same
// (api/src/domain-setup.ts, off unless NO_DOMAIN_REMINDER=on).

const DAY_MS = 24 * 3600_000
/** What the card takes above the figures on a desktop: its fixed 76px (no-domain.css) and its .ov-lead row's 4 + 12px padding. Latest emails fits its rows under it (latest.ts). */
export const NO_DOMAIN_SPACE = 76 + 16
const dismissedKey = (workspaceId: string) => `nightmail.overview.no-domain.${workspaceId}`
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function dismissedAt(workspaceId: string) { try { return Number(localStorage.getItem(dismissedKey(workspaceId))) || 0 } catch { return 0 } }
function dismiss(workspaceId: string) {
  try { localStorage.setItem(dismissedKey(workspaceId), String(Date.now())) } catch { /* Then it stays dismissed until a reload. */ }
  memory.add(workspaceId)
  listeners.forEach(listener => listener())
}
const memory = new Set<string>()

/** Whether the card shows: a hosted owner or admin, a ready connection, no domain, and not dismissed in the last day. `hasDomain`: the setup read, once it says otherwise. */
export function useNoDomainCard(hasDomain = false) {
  const identity = useSession()?.identity, { multiTenant, canAdminister } = useWorkspaceAccess()
  const workspaceId = identity?.workspaceId ?? ''
  const dismissed = useSyncExternalStore(subscribe, () => memory.has(workspaceId) || Date.now() - dismissedAt(workspaceId) < DAY_MS)
  return multiTenant && canAdminister && !!workspaceId && identity?.connection?.state === 'ready' && identity.connection.domains?.total === 0 && !hasDomain && !dismissed
}

const why = `${productName} sends from your own domain. Setting one up takes about 5 minutes of DNS.`
// Beside Add domain, the shared test sender's offer (api/src/test-sender.ts): a first email to the user's own address now.
// Once sent, it shows in Latest emails, the figures and the setup steps without a reload.
export function NoDomainCard() {
  const identity = useSession()?.identity, workspaceId = identity?.workspaceId ?? '', client = useQueryClient()
  const sent = () => void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && ['overview', 'overview-setup', 'logs', 'emails', 'sender-score', 'sending-limit'].includes(resourceOf(query.queryKey)) }).catch(() => {})
  return <section className="ov-no-domain" aria-labelledby="ov-no-domain-title">
    <div className="ov-no-domain__text">
      <h2 id="ov-no-domain-title">Add your domain to start sending</h2>
      <p title={why}>{why}</p>
    </div>
    {identity?.connection?.kind === 'shared' && <div className="ov-no-domain__test"><SelfTest confirm="logs" toastErrors onSent={sent} /></div>}
    {/* The onboarding domain step: an empty step opens it, and the dashboard's gate goes there. */}
    <Button variant="primary" className="ov-no-domain__action" onClick={() => setDomainStep(workspaceId, '')} data-analytics="overview/no-domain/add">Add domain<ArrowRight size={16} aria-hidden /></Button>
    <IconButton className="ov-no-domain__dismiss" label="Dismiss for a day" onClick={() => dismiss(workspaceId)} data-analytics="overview/no-domain/dismiss"><X size={16} aria-hidden /></IconButton>
  </section>
}
