import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import { Alert, Button, Checkbox, ConfirmDialog, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, ErrorText, type Column } from '../../components/ui'
import { useSession } from '../../data/context'
import { ApiError } from '../../data/types'
import { supportAgentsApi, supportAgentsKey, type SupportAgentApproval, type SupportAgentConnection, type SupportAgentRequest } from '../../data/support-agents'
import { relativeTime } from '../../lib/format'
import { agentColumnDefs, AgentsHeader, AgentsLead, StaffOnly } from './skeletons'
import { when } from './shared'

// Your agents (/operator/agents, from the support inbox's menu): the agents you approved to work the support inbox as you
// (api/src/support-agents.ts), and where an agent's link lands. An agent signed in over MCP asks first, with a code and
// /operator/agents?code=…; the dialog opens over the list once the request has loaded (so nothing moves) and approves or
// denies it. Only your own connections, from this staff session. Copy for your agent copies the prompt that starts it.
const CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/
/** A code as linked, in its shown form (BCDF-GHJK), or null if it can't be one. */
function readCode(value: string | null) {
  const code = (value ?? '').toUpperCase().replace(/[\s-]/g, '')
  return CODE.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : null
}
const def = (key: string) => agentColumnDefs.find(column => column.key === key)!
const agentName = (agent: SupportAgentConnection) => `${agent.client ?? 'Unnamed client'}${agent.profile ? ` · ${agent.profile}` : ''}`
function minutesLeft(at: string) {
  const minutes = Math.max(1, Math.round((Date.parse(at) - Date.now()) / 60_000))
  return minutes < 90 ? `${minutes} min left` : `${Math.round(minutes / 60)} h left`
}

export function OperatorAgentsPage() {
  const role = useSession()?.identity?.operator ?? null, client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const code = readCode(params.get('code'))
  const agents = useQuery({ queryKey: supportAgentsKey, enabled: Boolean(role), queryFn: ({ signal }) => supportAgentsApi.list(signal) })
  const [revoking, setRevoking] = useState<SupportAgentApproval | null>(null)
  const menu = useRef<HTMLElement | null>(null)
  if (!role) return <StaffOnly />
  const columns: Column<SupportAgentApproval>[] = [
    // The client's name is the connection's own claim; the approval dialog says so.
    { ...def('agent'), render: row => <span className="op-cell" title={`${agentName(row.agent)} (as the connection names itself)`}><bdi>{agentName(row.agent)}</bdi></span>, cardRender: row => agentName(row.agent) },
    { ...def('approved'), render: row => <span className="nowrap" title={when(row.approvedAt)}>{relativeTime(row.approvedAt)}</span>, cardRender: row => `Approved ${relativeTime(row.approvedAt)}` },
    { ...def('expires'), render: row => <span className="nowrap" title={when(row.expiresAt)}>{relativeTime(row.expiresAt)}</span>, cardRender: row => `Expires ${relativeTime(row.expiresAt)}` },
    { ...def('used'), render: row => row.lastUsedAt ? <span className="nowrap" title={when(row.lastUsedAt)}>{relativeTime(row.lastUsedAt)}</span> : <span className="muted">Not yet</span>,
      cardRender: row => row.lastUsedAt ? `Last used ${relativeTime(row.lastUsedAt)}` : 'Not used yet' },
    { ...def('actions'), render: row => <DropdownMenu label="Agent actions" title={agentName(row.agent)} items={[{ label: 'Revoke…', destructive: true, onSelect: () => { menu.current = document.activeElement as HTMLElement | null; setRevoking(row) } }]} /> },
  ]
  const closeRequest = () => setParams(previous => { const next = new URLSearchParams(previous); next.delete('code'); return next }, { replace: true })
  return <>
    <AgentsHeader />
    <div className="op-page">
      <AgentsLead />
      {agents.isError && !agents.data ? <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
        : <DataTable columns={columns} rows={agents.data?.data ?? []} rowKey={row => row.id} loading={agents.isPending} skeletonRows={3}
          empty={<EmptyState title="No agents yet" description="Copy for your agent, paste it into your agent, then approve the link it shows you." />} />}
    </div>
    {code && <ApproveDialog key={code} code={code} onClose={closeRequest} onApproved={() => void client.invalidateQueries({ queryKey: supportAgentsKey })} />}
    <ConfirmDialog open={revoking !== null} onOpenChange={next => { if (!next) setRevoking(null) }} danger returnFocus={menu} confirmLabel="Revoke"
      title={`Revoke ${revoking ? agentName(revoking.agent) : 'this agent'}?`} description="Its next call to the support inbox is refused."
      onConfirm={async () => { await supportAgentsApi.revoke(revoking!.id); await client.invalidateQueries({ queryKey: supportAgentsKey }) }} />
  </>
}

/** The request behind a link's code, to approve or deny: it opens once loaded, and says what came of the decision. Closing it is "not now". */
function ApproveDialog({ code, onClose, onApproved }: { code: string; onClose: () => void; onApproved: () => void }) {
  const request = useQuery({ queryKey: [...supportAgentsKey, 'request', code], retry: false, staleTime: Infinity, gcTime: 0, queryFn: ({ signal }) => supportAgentsApi.lookUp(code, signal) })
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [decided, setDecided] = useState<'approved' | 'denied' | null>(null)
  if (request.isPending) return null
  const agent = request.data
  const pending = agent?.status === 'pending' && !decided
  async function decide(decision: 'approve' | 'deny') {
    if (busy) return
    setBusy(decision); setError(null)
    try {
      await (decision === 'approve' ? supportAgentsApi.approve(code) : supportAgentsApi.deny(code))
      setDecided(decision === 'approve' ? 'approved' : 'denied')
      if (decision === 'approve') onApproved()
    } catch (cause) { setError(cause) }
    finally { setBusy(null) }
  }
  const close = () => { if (!busy) onClose() }
  const title = decided === 'approved' ? 'Agent approved' : decided === 'denied' ? 'Agent denied' : pending ? 'Approve this agent for the support inbox?' : 'Support inbox agent'
  return <Dialog open onOpenChange={next => { if (!next) close() }} title={title} className="op-agent-dialog" analytics="Approve support agent"
    footer={pending ? <>
      <Button disabled={Boolean(busy)} loading={busy === 'deny'} onClick={() => void decide('deny')}>Deny</Button>
      <Button variant="primary" disabled={!confirmed || Boolean(busy)} loading={busy === 'approve'} onClick={() => void decide('approve')}>Approve</Button>
    </> : <Button variant={decided ? 'primary' : undefined} onClick={close}>{decided ? 'Done' : 'Close'}</Button>}>
    {!agent ? <p className="muted">{request.error instanceof ApiError && request.error.status === 404 ? 'No agent of yours is waiting with that code.' : <ErrorText error={request.error} />}</p>
      : decided ? <p>{decided === 'approved' ? 'Ask your agent to try again.' : 'It gets nothing.'}</p>
      : !pending ? <Alert tone={agent.status === 'expired' ? 'warning' : 'info'} title={agent.userCode}>{agent.status === 'expired' ? 'This code expired. Ask your agent for a new one.'
        : agent.status === 'approved' ? 'Already approved.' : 'Denied: the agent got nothing.'}</Alert>
      : <Review agent={agent} confirmed={confirmed} onConfirmed={setConfirmed} disabled={Boolean(busy)} />}
    {error ? <Alert tone="danger"><ErrorText error={error} /></Alert> : null}
  </Dialog>
}

function Review({ agent, confirmed, onConfirmed, disabled }: { agent: SupportAgentRequest; confirmed: boolean; onConfirmed: (value: boolean) => void; disabled: boolean }) {
  return <div className="op-agent-review">
    <dl className="op-agent-facts">
      <dt>Code</dt><dd><code>{agent.userCode}</code><span className="muted"> · {minutesLeft(agent.expiresAt)}</span></dd>
      <dt>Agent</dt><dd>{agent.agent.client ? <><bdi>{agent.agent.client}</bdi><span className="muted"> · as it names itself</span></> : <span className="muted">Didn’t name itself</span>}</dd>
    </dl>
    <ul className="op-agent-grants" aria-label="What the agent can do">
      <li data-can><Check size={14} strokeWidth={2.5} aria-hidden /><span>{agent.can}</span></li>
      <li><X size={14} strokeWidth={2.5} aria-hidden /><span>Never: {agent.never.charAt(0).toLowerCase() + agent.never.slice(1)}</span></li>
    </ul>
    <p className="op-agent-note muted">Recorded as yours, via agent. Lasts {agent.days} days.</p>
    <Checkbox checked={confirmed} onCheckedChange={onConfirmed} disabled={disabled} label={<span>This is my agent, and it shows <span className="nowrap">{agent.userCode}</span></span>} />
  </div>
}
