import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Check, LogOut, X } from 'lucide-react'
import { Alert, Button, Checkbox, Field, Input, Select } from '../../components/ui'
import { BootLoader } from '../../components/BootLoader'
import { ThemeToggle } from '../../components/ThemeToggle'
import { NightmailWordmark } from '../../components/NightmailLogo'
import { useSession } from '../../data/context'
import { request } from '../../data/live'
import { ApiError, errorText } from '../../data/types'
import { productName } from '../../../../api/src/brand'
import '../onboarding/onboarding.css'
import './connect.css'

// /connect: where a person approves an agent that started the device flow (api/src/agent-setup.ts). The agent shows a
// code and this link; the person signs in, checks the code, chooses the workspace and approves or denies. Its key is the
// same one a copied prompt's setup token gives.
type AgentRequest = { userCode: string; clientName: string | null; status: 'pending' | 'approved' | 'denied' | 'used' | 'expired'; createdAt: string; expiresAt: string }
type Decision = 'approved' | 'denied'

const CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/
/** A code as typed or linked, in its shown form (BCDF-GHJK), or null if it can't be one. */
function readCode(value: string | null) {
  const code = (value ?? '').toUpperCase().replace(/[\s-]/g, '')
  return CODE.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : null
}
const rise = (i: number) => ({ '--i': i }) as CSSProperties

export function ConnectPage() {
  const session = useSession()
  useEffect(() => { document.title = `Connect an agent · ${productName.toLowerCase()}` }, [])
  return <div className="onboarding-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="onboarding-header">
      <span className="wordmark"><NightmailWordmark title={productName.toLowerCase()} /></span>
      <div className="onboarding-header-actions">
        <ThemeToggle />
        <Button variant="ghost" className="onboarding-signout" title="Sign out" onClick={() => void session?.logout()}><LogOut size={16} aria-hidden /><span className="onboarding-signout-label">Sign out</span></Button>
      </div>
    </header>
    <main id="main-content" className="page-surface onboarding-surface" tabIndex={-1}><ConnectSteps /></main>
  </div>
}

function ConnectSteps() {
  const [params, setParams] = useSearchParams()
  const code = readCode(params.get('code'))
  const [decided, setDecided] = useState<{ code: string; decision: Decision; workspace: string | null } | null>(null)
  // A code typed here is the person's confirmation; one that came in a link (anyone can send one) is confirmed below.
  const [typed, setTyped] = useState<string | null>(null)
  const looked = useQuery({ queryKey: ['agent-device', code], enabled: !!code, retry: false, staleTime: Infinity, gcTime: 0,
    queryFn: ({ signal }) => request<AgentRequest>('/v1/agent/device/lookup', { method: 'POST', body: { userCode: code }, signal }) })
  const choose = (next: string | null) => { setDecided(null); setTyped(next); setParams(next ? { code: next } : {}, { replace: true }) }
  let view: string, content: ReactNode
  if (decided && decided.code === code) { view = 'done'; content = <Decided decision={decided.decision} workspace={decided.workspace} onAnother={() => choose(null)} /> }
  else if (!code || looked.error) { view = 'enter'; content = <EnterCode initial={params.get('code') ?? ''} error={code ? looked.error : null} onCode={choose} /> }
  else if (looked.isPending) { view = 'loading'; content = <BootLoader inline /> }
  else if (looked.data.status !== 'pending') { view = 'closed'; content = <Closed request={looked.data} onAnother={() => choose(null)} /> }
  else { view = 'review'; content = <Review request={looked.data} typed={typed === code} onDecided={(decision, workspace) => setDecided({ code, decision, workspace })} onAnother={() => choose(null)} /> }
  return <div key={view} className="onboarding-step" data-motion={view === 'loading' ? undefined : 'fade'}>{content}</div>
}

function EnterCode({ initial, error, onCode }: { initial: string; error: unknown; onCode: (code: string) => void }) {
  const [draft, setDraft] = useState(initial)
  const [invalid, setInvalid] = useState('')
  function submit(event: FormEvent) {
    event.preventDefault()
    const code = readCode(draft)
    if (!code) { setInvalid('Type the eight letters your agent shows, like BCDF-GHJK.'); return }
    setInvalid(''); onCode(code)
  }
  const shown = invalid || (error ? lookupError(error) : '')
  return <div className="onboarding onboarding--narrow">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <h1 className="onboarding-title">Connect an agent</h1>
      <p className="muted connect-lead">Type the code your coding agent shows. You’ll see what it asks for before it gets anything.</p>
    </div>
    <form className="onboarding-inline-form onb-rise" style={rise(1)} onSubmit={submit} noValidate data-analytics="connect/code">
      <div className="onboarding-field">
        <Field label="Code" htmlFor="connect-code" error={shown || undefined}>
          <Input id="connect-code" autoFocus autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} value={draft} onChange={event => { setInvalid(''); setDraft(event.target.value) }} placeholder="BCDF-GHJK" maxLength={20} />
        </Field>
      </div>
      <Button type="submit" variant="primary" data-analytics="connect/code">Continue</Button>
    </form>
  </div>
}
function lookupError(error: unknown) {
  if (error instanceof ApiError && error.status === 404) return 'No agent is waiting with that code. Check it, or start again in your agent.'
  return errorText(error)
}

// What the agent's key may do (api/src/agent-setup.ts AGENT_PERMISSIONS), and what it never may.
const grants: [boolean, string][] = [
  [true, 'Send email from your domains'],
  [true, 'Add and verify domains, create inboxes and set up receiving'],
  [true, 'Read logs and received mail; manage webhooks, audience and campaigns'],
  [false, 'Never create API keys, inbox keys or mail-client (IMAP/SMTP) passwords'],
  [false, 'Never members or billing'],
]
function expiresIn(at: string) {
  const minutes = Math.max(1, Math.round((Date.parse(at) - Date.now()) / 60_000))
  return minutes < 90 ? `In ${minutes} min` : `In ${Math.round(minutes / 60)} h`
}

function Review({ request: agent, typed, onDecided, onAnother }: { request: AgentRequest; typed: boolean; onDecided: (decision: Decision, workspace: string | null) => void; onAnother: () => void }) {
  const identity = useSession()?.identity
  // Hosted: the workspaces this person owns or administers, the current one first. Self-hosted has the one it is in.
  const hosted = identity?.workspaces ?? null
  const choices = hosted ? hosted.filter(workspace => workspace.role === 'owner' || workspace.role === 'admin') : null
  const [workspace, setWorkspace] = useState(() => choices?.find(item => item.id === identity?.workspaceId)?.id ?? choices?.[0]?.id ?? '')
  const [busy, setBusy] = useState<Decision | null>(null)
  const [error, setError] = useState<unknown>(null)
  // From a link, Approve waits for the person to say the code is their own agent's (RFC 8628 §5.4): someone else can
  // start the flow and send the link, hoping for one click.
  const [confirmed, setConfirmed] = useState(typed)
  const canApprove = !choices || choices.length > 0
  async function decide(decision: Decision) {
    setBusy(decision); setError(null)
    try {
      await request(`/v1/agent/device/${decision === 'approved' ? 'approve' : 'deny'}`, { method: 'POST', body: { userCode: agent.userCode }, ...(decision === 'approved' && hosted ? { workspace } : {}) })
      onDecided(decision, decision === 'approved' ? hosted?.find(item => item.id === workspace)?.name ?? null : null)
    } catch (failure) { setError(failure); setBusy(null) }
  }
  return <div className="onboarding onboarding--narrow">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <h1 className="onboarding-title">Connect an agent?</h1>
      <p className="muted connect-lead">Approve only an agent you started just now, showing this code. Anyone can send you a link like this one.</p>
    </div>
    <dl className="connect-facts onb-rise" style={rise(1)}>
      <dt>Code</dt><dd><code>{agent.userCode}</code></dd>
      <dt>Agent</dt><dd>{agent.clientName ? <><bdi>{agent.clientName}</bdi><span className="muted"> · as it names itself</span></> : <span className="muted">Didn’t name itself</span>}</dd>
      <dt>Expires</dt><dd>{expiresIn(agent.expiresAt)}</dd>
    </dl>
    {choices && choices.length > 0 && <div className="onb-rise" style={rise(2)}>
      <Field label="Workspace" htmlFor="connect-workspace" hint={choices.length === 1 ? undefined : 'The agent’s key works in this workspace only.'}>
        <Select id="connect-workspace" value={workspace} onValueChange={setWorkspace} options={choices.map(item => ({ value: item.id, label: item.name }))} disabled={!!busy} />
      </Field>
    </div>}
    <section className="connect-grants onb-rise" style={rise(3)} aria-label="What the agent gets">
      <h2>Its own API key, which can:</h2>
      <ul>{grants.map(([can, text]) => <li key={text} data-can={can || undefined}>{can ? <Check size={14} strokeWidth={2.5} aria-hidden /> : <X size={14} strokeWidth={2.5} aria-hidden />}<span>{text}</span></li>)}</ul>
      <p className="muted">It’s listed under API keys as “Agent (set up {new Date().toISOString().slice(0, 10)})”. Revoke it there any time.</p>
    </section>
    {!typed && canApprove && <div className="onb-rise" style={rise(4)}><Checkbox checked={confirmed} onCheckedChange={setConfirmed} disabled={!!busy} label={`I started this agent, and it shows ${agent.userCode}`} /></div>}
    {!canApprove && <Alert tone="info">Only an owner or admin of a workspace can approve an agent. Ask one to open this link, or deny it.</Alert>}
    {error ? <Alert tone="danger">{errorText(error)}{error instanceof ApiError && <span className="ui-error-reference">{error.reference}</span>}</Alert> : null}
    <div className="onboarding-connect-actions connect-decide onb-rise" style={rise(5)}>
      <Button variant="primary" loading={busy === 'approved'} disabled={!canApprove || !confirmed || !!busy} onClick={() => void decide('approved')} data-analytics="connect/approve">Approve</Button>
      <Button variant="ghost" loading={busy === 'denied'} disabled={!!busy} onClick={() => void decide('denied')} data-analytics="connect/deny">Deny</Button>
      <button type="button" className="onboarding-skip connect-another" disabled={!!busy} onClick={onAnother}>Use another code</button>
    </div>
  </div>
}

function Decided({ decision, workspace, onAnother }: { decision: Decision; workspace: string | null; onAnother: () => void }) {
  const approved = decision === 'approved'
  return <div className="onboarding onboarding--narrow">
    <div className="onboarding-connect-status" data-state={approved ? 'ready' : 'failed'} role="status">
      <span className="onboarding-connect-mark" aria-hidden="true"><span className="onboarding-connect-dot" /><Check size={14} strokeWidth={3} /><X size={14} strokeWidth={3} /></span>
      <p><strong>{approved ? `Approved${workspace ? ` for ${workspace}` : ''}` : 'Denied'}</strong>
        <span>{approved ? 'Your agent gets its key on its next check, within seconds. You can close this page.' : 'Your agent gets nothing. You can close this page.'}</span></p>
    </div>
    <div className="onboarding-connect-actions">
      {approved && <Link className="ui-button ui-button--secondary ui-button--md" to="/api-keys">Open API keys</Link>}
      <Button variant="ghost" onClick={onAnother}>Use another code</Button>
    </div>
  </div>
}

function Closed({ request: agent, onAnother }: { request: AgentRequest; onAnother: () => void }) {
  const text = agent.status === 'expired' ? 'This code expired. Start again in your agent for a new one.'
    : agent.status === 'denied' ? 'This code was denied: the agent got nothing.'
    : agent.status === 'approved' ? 'This code was already approved. Its agent gets its key on its next check.'
    : 'This code was already used: its agent has its key.'
  return <div className="onboarding onboarding--narrow">
    <div className="onboarding-intro"><h1 className="onboarding-title">Connect an agent</h1></div>
    <Alert tone={agent.status === 'expired' ? 'warning' : 'info'} title={agent.userCode}>{text}</Alert>
    <div className="onboarding-connect-actions"><Button variant="primary" onClick={onAnother}>Use another code</Button></div>
  </div>
}
