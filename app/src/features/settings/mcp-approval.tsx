import { useState } from 'react'
import { useLocation, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, ErrorState, PageHeader, SectionHeader, Skeleton, StatusBadge } from '../../components/ui'
import { AccountAvatar } from '../../components/AccountSwitcher'
import { PrivateAddress } from '../../components/PrivateAddress'
import { accountApi, accountsKey } from '../../data/accounts'
import { useApiDef, useApiMutation, useSession } from '../../data/context'
import { invalidate } from '../../data/invalidation'
import { queries } from '../../data/queries'
import { McpApproval, Row } from './hosted'
import { agentAccess, connectionTitle } from './key-labels'

// One connected agent (/settings/mcp/<id>), linked from Settings and the rules page. One agent is one account: the account
// its client signed in as at the account service. On that account the page is just the agent: its account, then its default
// workspace. When the account is another one signed in here, it offers to continue as it; when it isn't here at all, it
// says so and offers to add it. Only an agent's own account can change it, so no picker is offered. What the agent may do
// (its access) is the header's badge once it loads.
export function McpApprovalPage() {
  const { id = '' } = useParams()
  const session = useSession()
  const location = useLocation()
  const identity = session?.identity
  const browser = useQuery({ queryKey: [...accountsKey, 'connection', id], queryFn: ({ signal }) => accountApi.list(signal, id), staleTime: 0 })
  const owner = browser.data?.connection?.account ?? null
  const self = owner && identity?.id === owner ? identity : null
  const connection = useApiDef(queries.ownAgent(id), { enabled: self !== null })
  const revoke = useApiMutation((api, agentId: string) => api.credentials.revokeAgent(agentId), 'Agent revoked', false, invalidate.agents)
  const [switching, setSwitching] = useState(false)
  const ownerAccount = browser.data?.accounts.find(account => account.id === owner)
  async function continueAs(account: string) {
    setSwitching(true)
    try { await session!.switchAccount(account, location.pathname) } finally { setSwitching(false) }
  }
  return <div className="stack mcp-approval">
    <PageHeader title="Connected agent" backTo="/settings#account" actions={self && connection.data ? <StatusBadge status={agentAccess(connection.data.permissions)} tone="neutral" /> : undefined} />
    <SectionHeader title="Account" />
    {browser.isError ? <ErrorState error={browser.error} onRetry={() => void browser.refetch()} />
      : !browser.data ? <div className="settings-rows"><div className="settings-row"><Skeleton width={220} height={20} /></div></div>
      : self ? <div className="settings-rows"><AgentAccount name={self.name} email={self.email} /></div>
      : owner ? <div className="settings-rows"><AgentAccount name={ownerAccount?.name} email={ownerAccount?.email} /></div>
      : <Alert tone="info" title="This agent used another account">Add that account to continue, or reconnect the client and choose it at Anomaly account. <Button variant="ghost" onClick={() => session?.addAccount(location.pathname)}>Use another account</Button></Alert>}
    {owner && !self && <div className="cluster"><Button variant="primary" loading={switching} onClick={() => void continueAs(owner)}>Continue as {ownerAccount?.name || ownerAccount?.email || 'this account'}</Button></div>}
    {self && <>
      <SectionHeader title="Default workspace" />
      {connection.isError ? <ErrorState error={connection.error} onRetry={() => void connection.refetch()} />
        : !connection.data ? <div className="settings-rows"><div className="settings-row"><Skeleton width={200} height={20} /></div></div>
        : connection.data.status === 'active' ? <div className="settings-rows"><McpApproval key={`${connection.data.id}:${connection.data.workspaceId}`} app={connection.data} workspaces={self.workspaces ?? []} linked={false} onRevoke={() => revoke.mutate(connection.data!.id)} /></div>
        : <div className="settings-rows"><Row title={connectionTitle(connection.data)}>{connection.data.status === 'expired' ? 'Expired · reconnect the client' : 'Revoked · reconnect the client'}</Row></div>}
    </>}
  </div>
}

// The agent's account, as one plain row: no radio, no picker, and no badge for a choice there is only one of.
function AgentAccount({ name, email }: { name?: string | null; email?: string | null }) {
  return <div className="settings-row mcp-approval__account">
    <span className="mcp-approval__who"><AccountAvatar name={name} email={email} /><span className="settings-row__label"><span title={name || undefined}>{name || email}</span>{email && <PrivateAddress className="muted" value={email} />}</span></span>
  </div>
}
