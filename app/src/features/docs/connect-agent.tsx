// Connecting an AI agent over MCP, in one place. Signed in as you (OAuth), each client's one-line setup comes from
// api/src/mcp-clients.ts (mcpSignIn): the sidebar's Connect an agent, Docs, onboarding and Ask your agent show it. With a
// key (an API key shown once, or one agent inbox's), the configs come from the builder createInboxConnection uses too.
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight, Check } from 'lucide-react'
import { Alert, Button, Checkbox, Dialog, ErrorState, Field, SearchField, Select, Tabs } from '../../components/ui'
import { usePhone } from '../../lib/media'
import { CopyAction } from '../../components/motion'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useApiDef, useApiQuery, usePublicOrigin, useSession, useWorkspaceAccess } from '../../data/context'
import { AgentSetupStatus, agentPrompt, useAgentSetup } from './agent-setup'
import { queries } from '../../data/queries'
import { inboxKeyEnv } from '../../../../api/src/brand'
import { request } from '../../data/live'
import { errorText, type Agent } from '../../data/types'
import { mcpClientNames, mcpClients, mcpClientSteps, mcpServerUrl, mcpSignIn, mcpSignInClients, mcpSignInNames, mcpSnippet, type McpAuth, type McpClient, type McpSignInClient } from '../../../../api/src/mcp-clients'
import { closeConnectAgent, useConnectAgentOpen } from '../../lib/connect-agent'
import { SecretField } from '../inbound/shared'
import { guides } from '../inbound/concepts'
import { agentAccess, connectionTitle } from '../settings/key-labels'
import './developer.css'
import { useSingleFlight } from '../../lib/single-flight'
import { useDebounced } from '../../lib/pagination'

const clientTabs = mcpClients.map(value => ({ value, label: mcpClientNames[value] }))
const signInTabs = mcpSignInClients.map(value => ({ value, label: mcpSignInNames[value] }))
// The client chosen for signing in, carried to the inbox key's setup: the same client where the setup has it, else the
// setup for any other MCP client (Other, Codex, ChatGPT, VS Code and Claude all take it).
const inboxClient = (client: McpSignInClient): McpClient => (mcpClients as readonly string[]).includes(client) ? client as McpClient : 'generic'

/** The hosted MCP URL on this installation's canonical address, or null until that is known. */
export function useMcpUrl() { const origin = usePublicOrigin(); return origin ? mcpServerUrl(origin) : null }

/**
 * Signed in as you: the one MCP URL with its copy button, a tab for each client (a picker on a phone, where eight tabs
 * don't fit) and that client's one-line setup (a command, an install link or its connector settings) with the steps after
 * it. The agent asks for the scopes the server names, so it gets your own access; there is nothing to choose first. Every
 * tab shares one cell, so the height holds, and until the address is known the same layout waits hidden. `urlLine={false}`
 * shows the URL only for the clients it is pasted into, since every command and install link already carries it.
 * `client` and `onClient` share the chosen client with the caller.
 */
export function McpSignInSetup({ label = 'Agent', urlLine = true, client: shared, onClient }: { label?: string; urlLine?: boolean; client?: McpSignInClient; onClient?: (client: McpSignInClient) => void }) {
  const url = useMcpUrl()
  const [own, setOwn] = useState<McpSignInClient>('opencode')
  const client = shared ?? own, setClient = onClient ?? setOwn
  const phone = usePhone()
  const shown = url ?? mcpServerUrl('https://example.com')
  const urlRow = <div className="developer-url connect-agent__url" data-pending={!url || undefined} inert={!url}><code>{shown}</code><CopyAction value={shown} label="Copy MCP URL" variant="ghost" size="sm" compact className="developer-copy-icon" /></div>
  return <div className="stack connect-agent__setup" aria-busy={!url || undefined}>
    {urlLine && urlRow}
    {phone ? <Select aria-label={label} value={client} onValueChange={value => setClient(value as McpSignInClient)} options={signInTabs} /> : <Tabs label={label} value={client} onValueChange={value => setClient(value as McpSignInClient)} items={signInTabs} />}
    <div className="developer-client-panels" data-pending={!url || undefined} inert={!url}>{mcpSignInClients.map(value => {
      const setup = mcpSignIn(value, shown), web = setup.link?.href.startsWith('https:')
      return <div key={value} className="stack developer-client-panel connect-agent__panel" data-active={value === client || undefined} inert={value !== client}>
        {!urlLine && !setup.command && (!setup.link || web) && urlRow}
        {setup.link && <a className="ui-button ui-button--secondary ui-button--md connect-agent__open" href={setup.link.href} {...web ? { target: '_blank', rel: 'noopener noreferrer' } : {}}>{setup.link.label}{web && <ArrowUpRight size={14} aria-hidden="true" />}</a>}
        {setup.command && <div className="developer-snippet">
          <pre className="developer-code connect-agent__command" tabIndex={0} aria-label={`${mcpSignInNames[value]} command`}><code>{setup.command}</code></pre>
          <CopyAction value={setup.command} label={`Copy ${mcpSignInNames[value]} command`} variant="ghost" size="sm" compact className="developer-copy-icon developer-snippet__copy" />
        </div>}
        {/* The command box already says to run it; Codex's longer first step says more, so it stays. */}
        <ol className="developer-steps">{setup.steps.filter(step => step !== 'Run it in a terminal.').map(step => <li key={step}>{step}</li>)}</ol>
      </div>
    })}</div>
  </div>
}

/** Client tabs for a config with a key, the snippet with its copy button and the steps after it. Every tab shares one
 *  cell, so the height holds. */
export function McpClientSetup({ client, onClient, url, auth, label = 'MCP client' }: { client: McpClient; onClient: (client: McpClient) => void; url: string | null; auth: McpAuth; label?: string }) {
  const kind = 'key' in auth || 'bearer' in auth ? 'key' : 'oauth'
  if (!url) return <p className="muted developer-copy" role="status">Loading this installation’s address…</p>
  return <div className="stack">
    <Tabs label={label} value={client} onValueChange={value => onClient(value as McpClient)} items={clientTabs} />
    <div className="developer-client-panels" data-sensitive={kind === 'key' || undefined}>{mcpClients.map(value => {
      const snippet = mcpSnippet(value, url, auth)
      return <div key={value} className="stack developer-client-panel" data-active={value === client || undefined} inert={value !== client}>
        <div className="developer-snippet">
          <pre className={snippet.startsWith('claude ') ? 'developer-code developer-code--wrap' : 'developer-code'} tabIndex={0} aria-label={`${mcpClientNames[value]} setup`}><code>{snippet}</code></pre>
          <CopyAction key={`${value}:${snippet.length}`} value={snippet} label={`Copy ${mcpClientNames[value]} setup`} variant="ghost" size="sm" compact className="developer-copy-icon developer-snippet__copy" />
        </div>
        <ol className="developer-steps">{mcpClientSteps(value, auth).map(step => <li key={step}>{step}</li>)}</ol>
      </div>
    })}</div>
  </div>
}

/** A key shown once beside this (an API key of any access), set up for each MCP client: the configs read it from `env`,
 *  so the key never sits in a file a project can commit (mcp-clients.ts). No second secret to mint. */
export function McpKeySetup({ secret, env }: { secret: string; env: string }) {
  const [client, setClient] = useState<McpClient>('opencode')
  return <div className="stack"><strong className="connect-agent__title">Use it with an agent</strong><McpClientSetup client={client} onClient={setClient} url={useMcpUrl()} auth={{ key: secret, env }} label="Agent" /></div>
}

// An agent counts as just connected when it is new, signed in again or called since the list this dialog first showed
// (cached or fetched): the server's own timestamps, so a skewed clock can't mark one.
const seen = (agent: Agent) => `${agent.createdAt}|${agent.lastUsedAt ?? ''}`
const everything = ['read', 'send', 'manage']

/**
 * Your agents signed in as you, polled while the dialog is open: the waiting row shows until you have one, and one that
 * connects (or calls) meanwhile is marked Connected. Each names the workspace its calls use when they name none, and what it can do
 * in this one: what its sign-in approved, within your role here (members read and send). Rows are the tables' 53px,
 * and the dialog's height is fixed, so the list loading or growing moves nothing.
 */
function ConnectedAgents({ onLeave }: { onLeave: () => void }) {
  const identity = useSession()?.identity
  const { multiTenant, role } = useWorkspaceAccess()
  const agents = useApiDef(queries.agents(false), { interval: 3000 })
  const mine = (agents.data ?? []).filter(agent => agent.own && agent.status === 'active')
  const [baseline, setBaseline] = useState<Map<string, string> | null>(null)
  useEffect(() => { if (!baseline && agents.data) setBaseline(new Map(mine.map(agent => [agent.id, seen(agent)]))) }, [agents.data]) // eslint-disable-line react-hooks/exhaustive-deps
  const fresh = (agent: Agent) => !!baseline && baseline.get(agent.id) !== seen(agent)
  const rows = [...mine.filter(fresh), ...mine.filter(agent => !fresh(agent))]
  const allowed = multiTenant && role === 'member' ? ['read', 'send'] : everything
  const workspaces = identity?.workspaces ?? []
  const where = (agent: Agent) => workspaces.find(workspace => workspace.id === agent.workspaceId)?.name ?? (workspaces.length === 1 ? workspaces[0].name : workspaces.length ? 'Last used workspace' : 'This workspace')
  return <section className="stack connect-agent__connected" aria-label="Connected agents">
    <ul className="connect-agent__agents" aria-live="polite">
      {!rows.length && <li className="connect-agent__agent connect-agent__waiting"><span className="connect-agent__pulse" aria-hidden="true" /><span className="muted">Waiting for your agent to sign in</span></li>}
      {rows.map(agent => <li key={agent.id} className="connect-agent__agent" data-fresh={fresh(agent) || undefined}>
        <span className="connect-agent__who">
          <Link to={`/settings/mcp/${encodeURIComponent(agent.id)}`} onClick={onLeave}>{connectionTitle(agent)}</Link>
          <span className="muted">{where(agent)} · {agentAccess(agent.permissions.filter(permission => allowed.includes(permission)))}</span>
        </span>
        {fresh(agent) && <span className="connect-agent__done">Connected<Check size={14} strokeWidth={2.5} aria-hidden="true" /></span>}
      </li>)}
    </ul>
    {agents.error && !agents.data && <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />}
  </section>
}

/**
 * For any coding agent, MCP or not: the agent prompt with a one-time setup token in each copy (agent-setup.tsx), as
 * onboarding and Docs copy it. The agent exchanges the token for its own API key; the line below says when it did.
 */
function SetupPrompt() {
  const identity = useSession()?.identity
  const origin = usePublicOrigin()
  const setup = useAgentSetup(true)!
  const prompt = (setupToken: string | undefined) => agentPrompt({ origin: origin!, domain: undefined, email: identity?.email ?? null, multiTenant: identity?.multiTenant === true, setupToken })
  return <section className="stack connect-agent__prompt" aria-label="Agent prompt">
    <div className="connect-agent__prompt-row" data-pending={!origin || undefined} inert={!origin}>
      <span className="connect-agent__prompt-text"><strong>Any coding agent</strong><span className="muted">Paste the prompt; your agent gets its own API key.</span></span>
      <CopyAction value={setup.copy(prompt)} label="Copy prompt" size="sm" />
    </div>
    <AgentSetupStatus setup={setup} />
  </section>
}

type Inbox = { id: string; address: string; name: string | null; status: string; type: 'ephemeral' | 'sandbox' }
type Connection = { id: string | null; config: object; nextStep: string; key: string | null; client: McpClient }

/**
 * Connect an agent: as you, signed in with OAuth, in any client (McpSignInSetup), with your agents listed below as they
 * connect. Limit to one inbox, a secondary step (owners and admins) makes an API key for that inbox that can't reach anything
 * else, inside a ready config. Opened from an inbox, that step and inbox are chosen. Every open starts fresh.
 */
export function ConnectAgentDialog({ open, onOpenChange, inboxId }: { open: boolean; onOpenChange: (open: boolean) => void; inboxId?: string }) {
  const { canAdminister } = useWorkspaceAccess()
  const identity = useSession()?.identity
  const url = useMcpUrl()
  const [view, setView] = useState<'agent' | 'inbox'>('agent')
  const [client, setClient] = useState<McpClient>('opencode')
  // The client chosen for signing in carries over to the inbox's config when that config supports it.
  const [signIn, setSignIn] = useState<McpSignInClient>('opencode')
  const [inbox, setInbox] = useState('')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Inbox | null>(null)
  const [reply, setReply] = useState(false)
  const [result, setResult] = useState<Connection | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inboxView = view === 'inbox' && canAdminister
  // A page of 100 active inboxes; past that, a search over address and name finds the rest. The inbox the dialog was
  // opened from, and the one last picked, stay in the list whatever the search shows.
  const search = useDebounced(query.trim())
  const inboxes = useApiQuery(['agent-inboxes', 'connect', search], (_api, signal) => request<{ data: Inbox[]; nextCursor: string | null }>(`/v1/inboxes?status=active&limit=100${search ? `&q=${encodeURIComponent(search)}` : ''}`, { signal }), { enabled: open && inboxView, keepPrevious: true })
  const opened = useApiQuery(['agent-inbox', inboxId], (_api, signal) => request<Inbox>(`/v1/inboxes/${encodeURIComponent(inboxId!)}`, { signal }), { enabled: open && canAdminister && !!inboxId })
  useEffect(() => {
    if (!open) return
    setView(inboxId && canAdminister ? 'inbox' : 'agent'); setClient('opencode'); setSignIn('opencode'); setInbox(inboxId ?? ''); setQuery(''); setPicked(null); setReply(false); setResult(null); setError('')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const kept = [picked, opened.data].filter((box): box is Inbox => !!box && box.status === 'active')
  const active = [...kept, ...(inboxes.data?.data ?? [])].filter((box, i, all) => box.status === 'active' && all.findIndex(other => other.id === box.id) === i)
  const searchable = !!search || !!query || !!inboxes.data?.nextCursor
  const chosen = inbox || active[0]?.id || ''
  const label = (box: Inbox) => <>{box.name ? `${box.name} · ` : null}<PrivateAddress value={box.address} /></>
  // Single flight: each call makes a new idempotency key, so a second click before the first answers would make a second key.
  const create = useSingleFlight('inbox-connections.create', async () => {
    if (!chosen) return
    setBusy(true); setError('')
    try {
      const made = await request<{ id: string | null; config: object; nextStep: string }>('/v1/inbox-connections', { method: 'POST', body: { inboxes: [chosen], client, auth: 'key', reply }, idempotencyKey: crypto.randomUUID() })
      // The key is inside the config, shown once; the snippet for every client is rebuilt from it.
      const bearer = JSON.stringify(made.config).match(/Bearer ((?:nm|bane)_mbx_[A-Za-z0-9_-]+)/)?.[1] ?? null // bane_: remove after rename cleanup
      setResult({ ...made, key: bearer, client })
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }, chosen)
  const close = () => { if (!busy) onOpenChange(false) }
  const footer = !inboxView ? <>
      <Link className="ui-button ui-button--ghost ui-button--md connect-agent__aside" to={guides.mcp} onClick={close}>Docs</Link>
      {canAdminister && <Button variant="ghost" className="connect-agent__aside" onClick={() => { setClient(inboxClient(signIn)); setView('inbox') }}>Limit to one inbox</Button>}
      <Button variant="primary" onClick={close}>Done</Button>
    </>
    : result ? <Button variant="primary" onClick={close}>Done</Button>
    : <><Button disabled={busy} onClick={() => { setView('agent'); setError('') }}>Back</Button><Button variant="primary" loading={busy} disabled={!chosen} onClick={() => void create()}>Create API key</Button></>
  return <Dialog open={open} onOpenChange={next => { if (!next) close() }} title={inboxView ? 'Connect an agent to one inbox' : 'Connect an agent'} analytics="Connect an agent" className="connect-agent-dialog" sensitive={!!result} footer={footer}>
    {!inboxView ? <div className="stack connect-agent">{canAdminister && identity && <SetupPrompt />}<McpSignInSetup urlLine={false} client={signIn} onClient={setSignIn} /><ConnectedAgents onLeave={close} /></div> : <div className="stack">
      {!result && <>
        {searchable && <SearchField aria-label="Search inboxes" placeholder="Search address or name" value={query} onChange={event => setQuery(event.target.value)} />}
        {inboxes.error && !inboxes.data && !active.length ? <ErrorState error={inboxes.error} onRetry={() => void inboxes.refetch()} />
          : inboxes.isPending || active.length || searchable ? <Field label="Inbox" hint={search && !inboxes.isFetching && !inboxes.data?.data.length ? 'No active inbox matches.' : inboxes.data?.nextCursor ? 'Showing first 100 active inboxes — search above to find others.' : undefined}>
          <Select mask aria-label="Inbox" value={chosen} onValueChange={id => { setInbox(id); setPicked(active.find(box => box.id === id) ?? null) }} disabled={inboxes.isPending} placeholder="Loading inboxes…" options={active.map(box => ({ value: box.id, label: label(box) }))} />
        </Field> : <div className="connect-agent__empty"><span>No active agent inboxes</span><Link className="ui-button ui-button--secondary ui-button--sm" to="/receiving/inboxes" onClick={close}>Create an agent inbox</Link></div>}
        <Checkbox checked={reply} onCheckedChange={setReply} label="Let it reply to senders (the inbox needs replies on)" />
        {/* Before the key exists: only the client, so the config made with the key is for the right one. */}
        <Field label="MCP client"><Select value={client} onValueChange={value => setClient(value as McpClient)} options={clientTabs} /></Field>
      </>}
      {result && <Alert tone="success" title="API key created">Copy the key now: it’s shown only once.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      {result?.key && <SecretField label="API key" value={result.key} copyLabel="Copy API key" />}
      {result?.key && <McpClientSetup client={client} onClient={setClient} url={url} auth={{ key: result.key, env: inboxKeyEnv }} />}
    </div>}
  </Dialog>
}

/** The shell's one Connect an agent (lib/connect-agent.ts opens it). */
export function ConnectAgentHost() {
  const open = useConnectAgentOpen()
  return <ConnectAgentDialog open={open} onOpenChange={next => { if (!next) closeConnectAgent() }} />
}

/** The button that opens it, wherever an agent might be connected from. */
export function ConnectAgentButton({ inboxId, variant = 'secondary', size = 'md', initiallyOpen = false }: { inboxId?: string; variant?: 'primary' | 'secondary' | 'ghost'; size?: 'sm' | 'md'; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  return <><Button variant={variant} size={size} onClick={() => setOpen(true)}>Connect an agent</Button><ConnectAgentDialog open={open} onOpenChange={setOpen} inboxId={inboxId} /></>
}
